const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { ChromaClient } = require('chromadb');
const https = require('https');
const readline = require('readline');
const Nano = require('nano');
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

// Nano (CouchDB Client)
// console.log('process.env.COUCHDB_HOST',process.env.COUCHDB_HOST);

// let couchUrl = 'https' + '://' + 'd_couchdb' + ':' + 'Welcome#2' + '@' + process.env.COUCHDB_HOST;
// console.log('couchUrl',couchUrl);

const nano = Nano({
  // url: couchUrl,
  url: `https://${process.env.COUCHDB_HOST}`,
  requestDefaults: {
    agent: new https.Agent({ rejectUnauthorized: false }),
    auth: {
      username:'d_couchdb',
      password:'Welcome#2',
    }
  }
});
const db = nano.db.use(process.env.COUCHDB_DB);

// Express middleware
app.use(cors({ origin: 'http://localhost:4200' }));
app.use(bodyParser.json());

// Helper function to embed given employeeId
const processAndEmbedEmployee = async (empId) => {
    try {
      const empDoc = await db.get(`employee_1_${empId}`).catch(() => null);
      if (!empDoc) return console.warn(`⚠️ No employee doc found for ${empId}`);
  
      const additional = await db.get(`additionalinfo_1_${empId}`).catch(() => null);
      const leave = await db.get(`leave_${empId}`).catch(() => null);
  
      const combinedData = {
        ...empDoc.data,
        additionalInfo: additional || {},
        leaveInfo: leave?.leaves || [],
      };
  
      const combinedText = JSON.stringify(combinedData);
      console.log(combinedText);
  
      const embeddingModel = genAI.getGenerativeModel({ model: 'embedding-001' });
      const embed = await embeddingModel.embedContent({ content: { parts: [{ text: combinedText }] } });
      const vector = embed?.embedding?.values;
      if (!vector) return;
  
      const collection = await chroma.getCollection({ name: 'employee-embeddings' });
      await collection.upsert({
        ids: [empDoc._id],
        embeddings: [vector],
        metadatas: [{ employeeId: empDoc._id, text: combinedText }],
        documents: [combinedText],
      });
  
      // Fetch embeddings count only after the upsert operation
      const embeddingsCount = await collection.peek({ limit: 1000 });
  
      if (embeddingsCount && embeddingsCount.ids) {
        console.log(`✅ Embedded and upserted employee ID: ${empId}`);
        console.log(`🔢 Total embeddings count in Chroma: ${embeddingsCount.ids.length}`);
      } else {
        console.log(`✅ Embedded and upserted employee ID: ${empId}`);
        console.log(`🔢 No embeddings in Chroma yet.`);
      }
  
    } catch (err) {
      console.error(`❌ Embedding error for ${empId}:`, err.message);
    }
  };
  

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
    const allDocs = await db.list({ include_docs: true });
    const employeeDocs = {};

    for (const row of allDocs.rows) {
      const doc = row.doc;
      if (doc._id.startsWith('employee_1_')) {
        const empId = doc.data.EmpID?.toString();
        if (empId) employeeDocs[empId] = true;
      }
    }

    console.log(`👥 Found ${Object.keys(employeeDocs).length} employee entries.`, employeeDocs);
    for (const empId of Object.keys(employeeDocs)) {
      await processAndEmbedEmployee(empId);
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
        // 1. Generate embedding with proper format
        const embeddingModel = genAI.getGenerativeModel({ model: 'embedding-001' });
        const embed = await embeddingModel.embedContent({
            content: { parts: [{ text: query }] 
            }
        })
        
        
        // Handle embedding response format
        const vector = embed.embedding?.values || embed.embedding;
        if (!vector || !Array.isArray(vector)) {
            return res.status(500).json({ error: 'Failed to generate embedding' });
        }

        // 2. Query ChromaDB with proper parameters
        const collection = await chroma.getCollection({ name: 'employee-embeddings' });
        const results = await collection.query({
            queryEmbeddings: [vector],
            nResults: 3,
            include: ['documents', 'metadatas', 'distances']
        });

        // 3. Process ChromaDB results
        if (!results.documents?.[0]?.length) {
            return res.status(404).json({ error: 'No matching documents found' });
        }

        // Parse the most relevant document
        const primaryDoc = JSON.parse(results.documents[0][0]);
        const metadata = results.metadatas[0][0];
        
        // 4. Construct context from best match
        const context = `Employee Record:
- ID: ${primaryDoc.EmpID}
- Name: ${primaryDoc.FirstName} ${primaryDoc.LastName}
- Department: ${primaryDoc.DepartmentType}
- Status: ${primaryDoc.EmployeeStatus}
- Email: ${primaryDoc.Email}
- Leave Info: ${primaryDoc.leaveInfo?.map(l => `${l.type} on ${l.date}`).join(', ')}`;

        // 5. Generate answer with Gemini
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-1.5-flash',
            generationConfig: { maxOutputTokens: 1000 }
        });

        const prompt = `Context:\n${context}\n\nQuestion: ${query}\nAnswer:`;
        
        const result = await model.generateContent({
            contents: [{
                role: "user",
                parts: [{ text: prompt }]
            }]
        });

        const response = await result.response;
        const answer = response.text();

        // 6. Format response with proper document references
        res.status(200).json({
            query,
            answer,
            sources: [{
                doc_id: results.ids[0][0], // Chroma document ID
                employee_id: primaryDoc.EmpID,
                document_type: metadata.type
            }],
            conversation: [
                { role: 'user', content: query },
                { role: 'assistant', content: answer }
            ]
        });

    } catch (err) {
        console.error('Processing Error:', err);
        res.status(500).json({
            error: 'Query processing failed',
            details: err.message
        });
    }
});
    


// Listen to CouchDB changes
const listenToChanges = async () => {
  console.log('👂 Listening to CouchDB changes...');
  
  const feed = db.changesReader.start({
    since: 'now',
    live: true,
    continuous: true,
    includeDocs: true,
  });

  feed.on('change', async (change) => {
    const doc = change.doc;
    if (!doc || !doc._id) return;

    let empId = null;

    if (doc._id.startsWith('employee_1_')) {
      empId = doc.data?.EmpID?.toString();
    } else if (doc._id.startsWith('leave_')) {
      empId = doc._id.replace('leave_', '');
    } else if (doc._id.startsWith('additionalinfo_1_')) {
      empId = doc._id.replace('additionalinfo_1_', '');
    }

    if (!empId) return;

    console.log(`🔁 Change detected. Re-embedding for employee ID: ${empId}`);
    await processAndEmbedEmployee(empId);
  });

  feed.on('error', (err) => {
    console.error('❌ Change feed error:', err);
  });
};

// App init
app.listen(PORT, async () => {
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
    await listenToChanges();
  });
});
