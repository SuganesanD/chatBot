// Replacing ES module imports with CommonJS require
const express = require('express');
const createError = require('http-errors');
const Joi = require('joi');
const axios = require('axios');
const https = require('https');
const { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const { RetrievalQA } = require('langchain/chains');
const { Chroma } = require('langchain');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');
const { Worker, isMainThread, parentPort } = require('worker_threads');


// 🌍 Load environment variables (if needed)
dotenv.config();

// 🚀 Create Express app
const app = express();
app.use(express.json());

// 🌐 Enable CORS for frontend
app.use(
  cors({
    origin: 'http://localhost:4200',
    credentials: true,
  })
);

// ⚙️ CouchDB connection parameters
const COUCHDB_URL = 'https://192.168.57.185:5984';
const COUCHDB_USERNAME = 'd_couchdb';
const COUCHDB_PASSWORD = 'Welcome#2';
const DATABASE_NAME = 'gowtham1';

// 🔐 Google Gemini API key
const GOOGLE_API_KEY = 'AIzaSyAvgwBW-yBqVq3a1MjwaTDELT1inUyXSYc';

// 🧠 Setup Gemini model through LangChain
const llm = new ChatGoogleGenerativeAI({
  modelName: 'gemini-pro',
  temperature: 0.3,
  apiKey: GOOGLE_API_KEY,
});

// 📂 Chroma vector database path
const CHROMA_DB_PATH = './chroma_db7';
if (!fs.existsSync(CHROMA_DB_PATH)) {
  fs.mkdirSync(CHROMA_DB_PATH, { recursive: true });
}

// ✅ Request validation (like Pydantic models)
const queryRequestSchema = Joi.object({
  query: Joi.string().required(),
});

const addEmployeeRequestSchema = Joi.object({
  doc_id: Joi.string().required(),
});

// 🔍 Regular expressions
const employeeRegex = /employee_1_(\d+)/;
const additionalInfoRegex = /additionalinfo_1_(\d+)/;
const leaveRegex = /leave_(\d+)/;

// 🛑 Disable SSL verification (development only!)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

// 📦 Export (or use this to build routes)
module.export ={
  app,
  axios,
  httpsAgent,
  COUCHDB_URL,
  COUCHDB_USERNAME,
  COUCHDB_PASSWORD,
  DATABASE_NAME,
  GOOGLE_API_KEY,
  CHROMA_DB_PATH,
  llm,
  queryRequestSchema,
  addEmployeeRequestSchema,
  employeeRegex,
  additionalInfoRegex,
  leaveRegex,
};


async function fetchDocument(doc_id) {
    try {
      const response = await axios.get(`${COUCHDB_URL}/${DATABASE_NAME}/${doc_id}`, {
        auth: {
          username: COUCHDB_USERNAME,
          password: COUCHDB_PASSWORD,
        },
        httpsAgent,
      });
  
      return response.data;
    } catch (error) {
      console.error(`❌ Error fetching document ${doc_id}:`, error.message);
      throw new Error(`Error fetching document ${doc_id}: ${error.message}`);
    }
  }

  async function retrieveAndCombineData(mainDocId, additionalInfoDocId, leaveDocId) {
    try {
      // Fetching documents from CouchDB
      const mainDoc = await fetchDocument(mainDocId);
      const additionalInfoDoc = await fetchDocument(additionalInfoDocId);
      const leaveDoc = await fetchDocument(leaveDocId);
  
      // Extract data from main employee document (nested inside 'data')
      const mainData = mainDoc?.data || {};
      const employeeId = mainData?.EmpID || 'N/A';
      const firstName = mainData?.FirstName || 'N/A';
      const lastName = mainData?.LastName || 'N/A';
      const startDate = mainData?.StartDate || 'N/A';
      const manager = mainData?.Manager || 'N/A';
      const email = mainData?.Email || 'N/A';
      const employeeStatus = mainData?.EmployeeStatus || 'N/A';
      const employeeType = mainData?.EmployeeType || 'N/A';
      const payZone = mainData?.PayZone || 'N/A';
      const departmentType = mainData?.DepartmentType || 'N/A';
      const division = mainData?.Division || 'N/A';
  
      // Extract data from additional info document
      const dob = additionalInfoDoc?.DOB || 'N/A';
      const state = additionalInfoDoc?.State || 'N/A';
      const genderCode = additionalInfoDoc?.GenderCode || 'N/A';
      const locationCode = additionalInfoDoc?.LocationCode || 'N/A';
      const maritalDesc = additionalInfoDoc?.MaritalDesc || 'N/A';
      const performanceScore = additionalInfoDoc?.['Performance Score'] || 'N/A';
      const currentEmployeeRating = additionalInfoDoc?.['Current Employee Rating'] || 'N/A';
  
      // Extract leave details
      const leaveEntries = leaveDoc?.leaves || [];
      const leaveDates = leaveEntries.map(entry => entry.date);
  
      // Combine all data into a single text string
      const combinedText = 
        `Employee ID: ${employeeId}\n` +
        `First Name: ${firstName}\n` +
        `Last Name: ${lastName}\n` +
        `Start Date: ${startDate}\n` +
        `Manager: ${manager}\n` +
        `Email: ${email}\n` +
        `Employee Status: ${employeeStatus}\n` +
        `Employee Type: ${employeeType}\n` +
        `Pay Zone: ${payZone}\n` +
        `Department Type: ${departmentType}\n` +
        `Division: ${division}\n` +
        `DOB: ${dob}\n` +
        `State: ${state}\n` +
        `Gender Code: ${genderCode}\n` +
        `Location Code: ${locationCode}\n` +
        `Marital Status: ${maritalDesc}\n` +
        `Performance Score: ${performanceScore}\n` +
        `Current Employee Rating: ${currentEmployeeRating}\n` +
        `Leave Dates: ${leaveDates.join(', ')}`;
  
      return combinedText;
  
    } catch (err) {
      console.error('❌ Error in retrieveAndCombineData:', err.message);
      throw new Error('Failed to retrieve and combine data.');
    }
  }

  async function addEmployeeDataToChroma(doc_id) {
    try {
      const employeeDoc = await fetchDocument(doc_id);
      const additionalInfoId = employeeDoc?.data?.additionalinfo_id || "";
      const additionalInfoNum = additionalInfoId.split('_').pop();
      const leaveId = `leave_${additionalInfoNum}`;
  
      if (additionalInfoId) {
        const additionalInfoDocId = `additionalinfo_1_${additionalInfoNum}`;
  
        // Fetch related documents
        const [additionalInfoDoc, leaveDoc] = await Promise.all([
          fetchDocument(additionalInfoDocId),
          fetchDocument(leaveId)
        ]);
  
        const hasEmployeeChanged = await hasDocumentChanged(doc_id);
        const hasAdditionalInfoChanged = await hasDocumentChanged(additionalInfoDocId);
        const hasLeaveChanged = await hasDocumentChanged(leaveId);
  
        if (hasEmployeeChanged || hasAdditionalInfoChanged || hasLeaveChanged) {
          await deleteRelatedEmbeddings(doc_id, additionalInfoId, leaveId);
  
          const employeeText = await retrieveAndCombineData(doc_id, additionalInfoDocId, leaveId);
  
          const embeddings = new GoogleGenerativeAIEmbeddings({
            model: 'models/embedding-001',
            apiKey: GOOGLE_API_KEY
          });
  
          const chromaDB = new Chroma({
            persistDirectory: CHROMA_DB_PATH,
            embeddingFunction: embeddings
          });
  
          await chromaDB.addTexts([employeeText], [{ doc_id }], [doc_id]);
          await chromaDB.persist();
  
          console.log(`Updated document ${doc_id} added to Chroma`);
          
          // Call the loadChromaDb method after the Chroma operation
          await loadChromaDb();  // This is where you call loadChromaDb
  
        } else {
          console.log(`No changes detected for ${doc_id}, no update needed.`);
        }
      }
    } catch (error) {
      console.error(`Error updating Chroma for document ${doc_id}:`, error.message);
      throw new Error(`Error updating Chroma for document ${doc_id}: ${error.message}`);
    }
  }
  
  // Function to check if the document has changed
async function hasDocumentChanged(docId) {
    try {
      const response = await axios.get(`${COUCHDB_URL}/${DATABASE_NAME}/${docId}`, {
        auth: {
          username: COUCHDB_USERNAME,
          password: COUCHDB_PASSWORD
        },
        httpsAgent
      });
  
      const currentSeq = response.data._rev;
  
      if (!lastSequences[docId] || lastSequences[docId] !== currentSeq) {
        lastSequences[docId] = currentSeq;
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error checking document change for ${docId}:`, error.message);
      return false;
    }
  }

  module.exports.hasDocumentChanged =hasDocumentChanged
  
  // Monitor CouchDB _changes feed for real-time updates
  async function monitorCouchDBChanges() {
    let lastSeq = null;
  
    try {
      while (true) {
        const params = lastSeq ? { since: lastSeq } : {};
        const response = await axios.get(`${COUCHDB_URL}/${DATABASE_NAME}/_changes`, {
          auth: {
            username: COUCHDB_USERNAME,
            password: COUCHDB_PASSWORD
          },
          params,
          httpsAgent
        });
  
        const changes = response.data;
  
        for (const change of changes.results || []) {
          const docId = change.id;
  
          if (change.deleted) {
            console.log(`Document ${docId} has been deleted. Skipping.`);
            continue;
          }
  
          try {
            let employeeId = null;
  
            if (additionalinfoRegex.test(docId) || leaveRegex.test(docId)) {
              const match = docId.match(/_(\d+)$/);
              if (match) {
                employeeId = `employee_1_${match[1]}`;
                console.log(`Transformed document ID to employee ID: ${employeeId}`);
              }
            }
  
            if (employeeId) {
              await addEmployeeDataToChroma(employeeId);
            } else if (employeeRegex.test(docId)) {
              await addEmployeeDataToChroma(docId);
            }
  
          } catch (err) {
            console.error(`Error processing document ${docId}:`, err.message);
          }
        }
  
        lastSeq = changes.last_seq;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } catch (err) {
      console.error('Error monitoring CouchDB changes:', err.message);
    }
  }

  module.exports.monitorCouchDBChanges =monitorCouchDBChanges

  

 // Make sure to update the path as necessary
let chromaDb = null;

// Function to delete related embeddings for employee, additional info, and leave documents
const deleteRelatedEmbeddings = async (employeeId, additionalInfoId, leaveId) => {
    try {
        // Initialize Chroma database
        const chroma = new Chroma({
            persistDirectory: CHROMA_DB_PATH,
            embeddingFunction: new GoogleGenerativeAIEmbeddings({
                model: 'models/embedding-001',
                googleApiKey: process.env.GOOGLE_API_KEY, // Ensure to set your Google API Key here
            }),
        });

        // Collect IDs to delete
        const idsToDelete = [employeeId, `additionalinfo_${additionalInfoId}`, leaveId];

        // Perform deletion
        await chroma.delete(idsToDelete);
        console.log(`Old embeddings deleted for ${employeeId}, additionalinfo_${additionalInfoId}, and ${leaveId}`);
    } catch (deleteErr) {
        console.error(`Error deleting old embeddings: ${deleteErr}`);
    }
};

// Load Chroma vector store on app startup
const loadChromaDb = async () => {
    try {
        const chroma = new Chroma({
            persistDirectory: CHROMA_DB_PATH,
            embeddingFunction: new GoogleGenerativeAIEmbeddings({
                model: 'models/embedding-001',
                googleApiKey: process.env.GOOGLE_API_KEY, // Ensure to set your Google API Key here
            }),
        });

        // Store the chroma instance in a global variable
        chromaDb = chroma;
        console.log("Chroma vector store loaded successfully on startup");
    } catch (e) {
        console.error(`Error loading Chroma vector store: ${e}`);
        throw new Error(e);
    }
};

const conversationHistory = {};

app.post("/query", async (req, res) => {
    try {
      const { query } = req.body;
      const userId = "some_user_id"; // Typically, you would extract this from a session or JWT
  
      // Initialize conversation history for a new user
      if (!conversationHistory[userId]) {
        conversationHistory[userId] = [];
      }
  
      // Add the user's query to the conversation history
      conversationHistory[userId].push({ role: 'user', message: query });
  
      // Use Chroma as a retriever
      const vectorIndex = chromaDb.asRetriever({ searchK: 1000 });
  
      // Query the vector store using LLM
      const llm = new GoogleGenerativeAIEmbeddings({
        model: "gemini-1.5-flash",
        googleApiKey: process.env.GOOGLE_API_KEY,
      });
  
      const qaChain = new RetrievalQA({ llm, retriever: vectorIndex, returnSourceDocuments: true });
  
      // Perform the query
      const result = await qaChain.query({ query });
  
      // Extract relevant metadata (doc_id)
      let sources = [];
      if (result.source_documents) {
        const mostRelevantDoc = result.source_documents[0];
        const docId = mostRelevantDoc.metadata.doc_id || "Unknown";
  
        let relatedDocs = [];
        if (/employee_/.test(docId)) {
          relatedDocs = [
            docId,
            docId.replace("employee_", "additionalinfo_"),
            docId.replace("employee_", "leave_"),
          ];
        } else if (/additionalinfo_/.test(docId)) {
          relatedDocs = [
            docId.replace("additionalinfo_", "employee_"),
            docId,
            docId.replace("additionalinfo_", "leave_"),
          ];
        } else if (/leave_/.test(docId)) {
          relatedDocs = [
            docId.replace("leave_", "employee_"),
            docId.replace("leave_", "additionalinfo_"),
            docId,
          ];
        } else {
          relatedDocs = [docId];
        }
  
        sources = relatedDocs.map(doc => ({ doc_id: doc }));
      }
  
      // Add the assistant's response to the conversation history
      conversationHistory[userId].push({ role: 'assistant', message: result.result });
  
      // Send response back
      res.json({
        query,
        answer: result.result,
        sources,
        conversation: conversationHistory[userId],
      });
    } catch (error) {
      res.status(500).json({ error: `Error processing query: ${error.message}` });
    }
  });
  
  // Endpoint to manually add or update employee data in Chroma
  app.post("/add_employee", async (req, res) => {
    try {
      const { doc_id } = req.body;
      await addEmployeeDataToChroma(doc_id);
      res.json({ status: "Employee data added/updated in Chroma" });
    } catch (error) {
      res.status(500).json({ error: `Error adding employee data: ${error.message}` });
    }
  });
  
  // // Function to add employee data to Chroma (same logic)
  // const addEmployeeDataToChroma = async (docId) => {
  //   // Your logic for adding employee data to Chroma
  //   console.log(`Adding data for employee ${docId} to Chroma`);
  // };
  
  // Initialize Chroma DB on startup
  initializeChromaDb().catch(err => {
    console.error('Error initializing Chroma DB:', err);
  });
  
  // Start CouchDB monitoring
  monitorCouchdbChanges();
  
  // Start the server
  const PORT = process.env.PORT || 8000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  