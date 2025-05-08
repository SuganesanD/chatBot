const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const https = require('https');
const readline = require('readline');
const Nano = require('nano');
require('dotenv').config({ path: './couchdb_credentials.env' });

const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const { Chroma } = require('@langchain/community/vectorstores/chroma');
const { Document } = require('@langchain/core/documents');
const { RetrievalQAChain } = require('langchain/chains');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');

// Validate env variables
['COUCHDB_HOST', 'COUCHDB_USERNAME', 'COUCHDB_PASSWORD', 'COUCHDB_DB', 'GOOGLE_API_KEY'].forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Missing environment variable: ${key}`);
    process.exit(1);
  }
});

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Ignore self-signed certs

const app = express();
const PORT = 3000;

app.use(cors({ origin: 'http://localhost:4200' }));
app.use(bodyParser.json());

// CouchDB Setup
const nano = Nano({
  url: `https://${process.env.COUCHDB_HOST}`,
  requestDefaults: {
    agent: new https.Agent({ rejectUnauthorized: false }),
    auth: {
      username: 'd_couchdb',
      password: 'Welcome#2',
    },
  },
});
const db = nano.db.use(process.env.COUCHDB_DB);

// Wrap everything in an async IIFE
(async () => {
  // LangChain setup
  const embedding = new GoogleGenerativeAIEmbeddings({
    modelName: 'embedding-001',
    apiKey: process.env.GOOGLE_API_KEY,
  });

  const llm = new ChatGoogleGenerativeAI({
    model: 'models/gemini-1.5-flash',
    apiKey: process.env.GOOGLE_API_KEY,
    temperature: 0.3,
    maxOutputTokens: 1000,
  });

  // Create Chroma vector store
  let vectorStore;
  try {
    vectorStore = await Chroma.fromDocuments([], embedding, {
      collectionName: 'employee-embeddings',
      url: 'http://localhost:8000',
      collectionMetadata: {
        "hnsw:space": "cosine" // Required metadata for Chroma
      },
      chromaClientOptions: {
        timeout: 30000 // Increased timeout for connection
      }
    });
  } catch (err) {
    console.error("❌ Error connecting to Chroma:", err.message);
    console.error("Detailed Error:", err);
    process.exit(1); // Exit if Chroma connection fails
  }
  
  const chain = new RetrievalQAChain({
    llm: llm,
    retriever: vectorStore.asRetriever(),
    returnSourceDocuments: true,
  });

  // Embedding logic
  const processAndEmbedEmployee = async (empId) => {
    try {
      const empDoc = await db.get(`employee_1_${empId}`).catch(() => null);
      if (!empDoc) return;

      const additional = await db.get(`additionalinfo_1_${empId}`).catch(() => null);
      const leave = await db.get(`leave_${empId}`).catch(() => null);

      const combinedData = {
        ...empDoc.data,
        additionalInfo: additional || {},
        leaveInfo: leave?.leaves || [],
      };

      const combinedText = JSON.stringify(combinedData);
      const doc = new Document({
        pageContent: combinedText,
        metadata: { employeeId: empDoc._id },
      });

      await vectorStore.addDocuments([doc]);

      console.log(`✅ Embedded employee: ${empId}`);
    } catch (err) {
      console.error(`❌ Failed to embed ${empId}:`, err.message);
    }
  };

  // Initialize all embeddings
  const initializeEmbeddings = async ({ deleteExisting = false } = {}) => {
    if (deleteExisting) {
      try {
        await vectorStore.delete({ deleteAll: true });
        console.log('🧹 Deleted existing embeddings.');
      } catch (err) {
        console.error("❌ Error deleting existing embeddings:", err);
      }
    }

    const allDocs = await db.list({ include_docs: true });
    const employeeDocs = {};

    for (const row of allDocs.rows) {
      const doc = row.doc;
      if (doc._id.startsWith('employee_1_')) {
        const empId = doc.data?.EmpID?.toString();
        if (empId) employeeDocs[empId] = true;
      }
    }

    for (const empId of Object.keys(employeeDocs)) {
      await processAndEmbedEmployee(empId);
    }

    console.log(`🎉 All embeddings initialized for ${Object.keys(employeeDocs).length} employees.`);
  };

  // Query endpoint
  app.post('/query', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query is required' });

    try {
      const result = await chain.call({ query });

      const sources = result.sourceDocuments.map(doc => {
        const parsed = JSON.parse(doc.pageContent);
        return {
          employeeId: parsed.EmpID || doc.metadata.employeeId,
          name: `${parsed.FirstName || ''} ${parsed.LastName || ''}`.trim(),
          department: parsed.DepartmentType || '',
        };
      });

      res.status(200).json({
        query,
        answer: result.text,
        sources,
      });
    } catch (err) {
      console.error('❌ Query error:', err);
      res.status(500).json({
        error: 'Query failed',
        details: err.message,
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

      console.log(`🔄 Re-embedding for employee ID: ${empId}`);
      await processAndEmbedEmployee(empId);
    });

    feed.on('error', (err) => {
      console.error('❌ Change feed error:', err);
    });
  };

  // Start the server after initialization
  app.listen(PORT, async () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('❓ Delete existing embeddings? (yes/no): ', async (answer) => {
      const shouldDelete = answer.trim().toLowerCase() === 'yes';
      await initializeEmbeddings({ deleteExisting: shouldDelete });
      rl.close();
      await listenToChanges();
    });
  });

})();
