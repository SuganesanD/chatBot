const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { ChromaClient } = require('chromadb');
const axios = require('axios');
const https = require('https');
const readline = require('readline');
require('dotenv').config({ path: './couchdb_credentials.env' });

// Validate env variables
['COUCHDB_HOST', 'COUCHDB_USERNAME', 'COUCHDB_PASSWORD', 'COUCHDB_DB', 'GOOGLE_API_KEY'].forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Missing environment variable: ${key}`);
    process.exit(1);
  }
});

// Setup
const app = express();
const PORT = 3000;
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const chroma = new ChromaClient({ path: 'http://127.0.0.1:8000' });

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Ignore self-signed certs

// CouchDB Setup (Axios with Agent)
const agent = new https.Agent({ rejectUnauthorized: false });
const couchdbUrl = `https://192.168.57.185:5984`;

const axiosInstance = axios.create({
  baseURL: couchdbUrl,
  httpsAgent: agent,
  auth: {
    username: 'd_couchdb',
    password: 'Welcome#2'
  }
});

app.use(cors({ origin: 'http://localhost:4200' }));
app.use(bodyParser.json());

// Extract related IDs
const extractRelatedDocIds = (employeeId) => {
  const match = employeeId.match(/employee_1_(\d+)/);
  if (!match) return null;
  const id = match[1];
  return {
    employeeId: `employee_1_${id}`,
    leaveId: `leave_${id}`,
    additionalInfoId: `additionalinfo_1_${id}`,
  };
};

// Embed all employee docs
const initializeEmbeddings = async ({ deleteExisting = false } = {}) => {
  try {
    console.log("🔄 Creating 'employee-embeddings' collection if not exists...");
    await chroma.createCollection({ name: 'employee-embeddings' }).catch(() => {});
    const collection = await chroma.getCollection({ name: 'employee-embeddings' });
    console.log("✅ Collection retrieved.");

    if (deleteExisting) {
      console.log("🧹 Deleting all existing embeddings...");
      const existingIds = await collection.peek({ limit: 1000 });
      if (existingIds && existingIds.ids?.length > 0) {
        await collection.delete({ ids: existingIds.ids });
        console.log("🗑️ Embeddings deleted.");
      } else {
        console.log("ℹ️ No embeddings found to delete.");
      }
    }

    console.log("📥 Fetching all documents from CouchDB...");
    const allDocs = await axiosInstance.get(`/gowtham1/_all_docs?include_docs=true`);
    const rows = allDocs.data.rows;

    const employeeDocs = {};
    const additionalInfoDocs = {};
    const leaveDocs = {};

    for (const row of rows) {
      const doc = row.doc;
      if (doc._id.startsWith('employee_1_')) {
        const id = doc.data.EmpID.toString();
        employeeDocs[id] = doc;
      } else if (doc._id.startsWith('additionalinfo_')) {
        const id = doc._id.split('_')[1];
        additionalInfoDocs[id] = doc;
      } else if (doc._id.startsWith('leave_')) {
        const id = doc._id.split('_')[1];
        leaveDocs[id] = doc;
      }
    }

    console.log(`👥 Found ${Object.keys(employeeDocs).length} employee entries.`);
    const embeddingModel = genAI.getGenerativeModel({ model: 'embedding-001' });
    console.log("🧠 Google Generative AI embedding model loaded.");

    for (const empId of Object.keys(employeeDocs)) {
      console.log(`\n➡️ Processing employee ID: ${empId}`);
      const empDoc = employeeDocs[empId];

      const existing = await collection.get({ ids: [empDoc._id] }).catch(() => null);
      if (existing && existing.ids?.length > 0) {
        console.log(`⚠️ Embedding already exists for ${empDoc._id} — Skipping.`);
        continue;
      }

      const additional = additionalInfoDocs[empId] || {};
      const leave = leaveDocs[empId] || {};

      const combinedData = {
        ...empDoc.data,
        additionalInfo: additional,
        leaveInfo: leave.leaves || [],
      };

      const combinedText = JSON.stringify(combinedData);
      console.log("📝 Combined text for embedding:", combinedText);

      const embed = await embeddingModel.embedContent({
        content: { parts: [{ text: combinedText }] }
      });

      console.log("📊 Embedding response received.");
      const vector = embed?.embedding?.values;

      if (!vector) {
        console.warn(`⚠️ Skipping employee ID ${empId} — No embedding vector returned.`);
        continue;
      }

      await collection.upsert({
        ids: [empDoc._id],
        embeddings: [vector],
        metadatas: [{ employeeId: empDoc._id, text: combinedText }],
        documents: [combinedText],
      });

      console.log(`✅ Embedded and upserted employee ID: ${empId}`);
    }

    console.log('\n🎉 All embeddings initialized successfully.');
  } catch (err) {
    console.error('❌ Error initializing embeddings:', err);
  }
};

// Handle query
app.post('/query', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query is required' });

  try {
    const embeddingModel = genAI.getGenerativeModel({ model: 'embedding-001' });
    const embed = await embeddingModel.embedContent({
      content: query
    });
    const vector = embed?.embedding?.values;
    if (!vector) return res.status(500).json({ error: 'Failed to generate embedding' });

    const collection = await chroma.getCollection({ name: 'employee-embeddings' });
    const results = await collection.query({ queryEmbeddings: [vector], nResults: 1 });
    const match = results?.[0];

    let context = '';
    let sourceIds = [];
    if (match?.metadatas?.[0]) {
      context = match.metadatas[0].text;
      sourceIds.push(match.metadatas[0].employeeId);
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent([
      { role: 'system', parts: [{ text: context }] },
      { role: 'user', parts: [{ text: query }] },
    ]);
    const response = await result.response;
    const text = response.text();

    res.status(200).json({
      query,
      answer: text,
      sources: sourceIds,
      conversation: [
        { role: 'user', content: query },
        { role: 'bot', content: text },
      ],
    });
  } catch (err) {
    console.error('❌ Gemini AI error:', err);
    res.status(500).json({ error: 'Query processing failed', details: err.message });
  }
});

// Start server with interactive prompt
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('❓ Do you want to delete existing embeddings? (yes/no): ', async (answer) => {
    const input = answer.trim().toLowerCase();
    if (input === 'yes') {
      await initializeEmbeddings({ deleteExisting: true });
    } else if (input === 'no') {
      console.log('⏭️ Skipping embedding process as per user input.');
    } else {
      console.log('⚠️ Invalid input. Skipping embedding process by default.');
    }
    rl.close();
  });
});

// 👇👇 ADDITIONAL LOGIC: Listen for new data every 3 minutes 👇👇
let embeddedEmployeeIds = new Set();

// This function will check for new employee documents and process only new ones
const checkForNewDocuments = async () => {
  console.log(`🔍 Checking for new employee documents...`);
  try {
    // Fetch all documents from CouchDB
    const allDocs = await axiosInstance.get(`/gowtham1/_all_docs?include_docs=true`);
    const rows = allDocs.data.rows;

    const employeeDocs = {};
    const additionalInfoDocs = {};
    const leaveDocs = {};

    // Sort out the employee, additional info, and leave documents
    for (const row of rows) {
      const doc = row.doc;
      if (doc._id.startsWith('employee_1_')) {
        if (!embeddedEmployeeIds.has(doc._id)) {  // Process only if not already embedded
          const id = doc.data.EmpID.toString();
          employeeDocs[id] = doc;
        }
      } else if (doc._id.startsWith('additionalinfo_')) {
        const id = doc._id.split('_')[1];
        additionalInfoDocs[id] = doc;
      } else if (doc._id.startsWith('leave_')) {
        const id = doc._id.split('_')[1];
        leaveDocs[id] = doc;
      }
    }

    // If no new documents, exit early
    if (Object.keys(employeeDocs).length === 0) {
      console.log("✅ No new employee documents found.");
      return;
    }

    // Retrieve the Chroma collection
    const collection = await chroma.getCollection({ name: 'employee-embeddings' });
    const embeddingModel = genAI.getGenerativeModel({ model: 'embedding-001' });

    // Process each new employee document
    for (const empId of Object.keys(employeeDocs)) {
      const empDoc = employeeDocs[empId];
      const additional = additionalInfoDocs[empId] || {};
      const leave = leaveDocs[empId] || {};

      const combinedData = {
        ...empDoc.data,
        additionalInfo: additional,
        leaveInfo: leave.leaves || [],
      };

      console.log(combinedData);
      

      const combinedText = JSON.stringify(combinedData);
      console.log(`🆕 New employee data found: ${empDoc._id}`);

      // Generate the embedding for this new document
      const embed = await embeddingModel.embedContent({
        content: { parts: [{ text: combinedText }] }
      });

      const vector = embed?.embedding?.values;
      if (!vector) {
        console.warn(`⚠️ Skipping employee ID ${empId} — No embedding vector returned.`);
        continue;
      }

      // Store the embedding in ChromaDB
      await collection.upsert({
        ids: [empDoc._id],
        embeddings: [vector],
        metadatas: [{ employeeId: empDoc._id, text: combinedText }],
        documents: [combinedText],
      });

      // Mark this document as processed by adding it to the embeddedEmployeeIds set
      embeddedEmployeeIds.add(empDoc._id);
      console.log(`✅ Embedded new employee document: ${empDoc._id}`);
    }

    console.log(`⏱️ Done checking for new documents.`);
  } catch (err) {
    console.error('❌ Error during periodic document check:', err.message);
  }
};

// Run the document check every 3 minutes (180000 ms)
setInterval(checkForNewDocuments, 0.5 * 60 * 1000);

// You can also initialize embeddings initially if you want to process existing documents

