// Import required modules
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const https = require('https');

// Initialize dotenv for environment variables
dotenv.config();

// Initialize Express app
const app = express();
app.use(express.json());
app.use(cors());

// CouchDB connection parameters
const COUCHDB_URL = process.env.COUCHDB_URL || 'https://192.168.57.185:5984';
const COUCHDB_USERNAME = process.env.COUCHDB_USERNAME || 'd_couchdb';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || 'Welcome#2';
const DATABASE_NAME = process.env.DATABASE_NAME || 'gowtham1';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyAvgwBW-yBqVq3a1MjwaTDELT1inUyXSYc';

// Google Generative AI setup
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

// Chroma DB setup
const CHROMA_DB_PATH = './chroma_db7';
if (!fs.existsSync(CHROMA_DB_PATH)) {
  fs.mkdirSync(CHROMA_DB_PATH, { recursive: true });
}

// Regex patterns
const employeeRegex = /employee_1_(\d+)/;
const additionalinfoRegex = /additionalinfo_1_(\d+)/;
const leaveRegex = /leave_(\d+)/;

// Function to fetch document from CouchDB
const fetchDocument = async (docId) => {
  try {
    const response = await axios.get(`${COUCHDB_URL}/${DATABASE_NAME}/${docId}`, {
      auth: {
        username: COUCHDB_USERNAME,
        password: COUCHDB_PASSWORD,
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    return response.data;
  } catch (error) {
    throw new Error(`Error fetching document ${docId}: ${error.message}`);
  }
};

// Endpoint to fetch all documents
app.get('/api/docs', async (req, res) => {
  try {
    const response = await axios.get(`${COUCHDB_URL}/${DATABASE_NAME}/_all_docs?include_docs=true`, {
      auth: {
        username: COUCHDB_USERNAME,
        password: COUCHDB_PASSWORD,
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    const docs = response.data.rows.map(row => row.doc);
    res.json(docs);
  } catch (err) {
    console.error('❌ Error fetching documents:', err.message);
    res.status(500).json({ error: 'Failed to fetch documents from CouchDB.' });
  }
});

// Function to identify document type using regex patterns
const identifyDocumentType = (docId) => {
  if (employeeRegex.test(docId)) {
    return 'employee';
  } else if (additionalinfoRegex.test(docId)) {
    return 'additionalinfo';
  } else if (leaveRegex.test(docId)) {
    return 'leave';
  } else {
    return 'unknown';
  }
};

// Function to fetch document and process it
const fetchAndProcessDocument = async (docId) => {
  try {
    const document = await fetchDocument(docId); // Fetch the document
    const docType = identifyDocumentType(docId); // Identify document type

    // Return document type and content for now
    return { docType, document };
  } catch (error) {
    throw new Error(`Error processing document: ${error.message}`);
  }
};

// Route: /query
app.post('/query', async (req, res) => {
  const { query } = req.body;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(query);
    const response = await result.response;
    const text = response.text();

    res.status(200).json({ response: text });
  } catch (error) {
    console.error("Gemini AI error:", error);
    res.status(500).json({
      error: 'Query processing failed',
      details: error.message,
    });
  }
});

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

// Route: /addEmployee
app.post('/addEmployee', async (req, res) => {
  const { doc_id } = req.body;

  try {
    const ids = extractRelatedDocIds(doc_id);
    if (!ids) {
      return res.status(400).json({ error: 'Invalid employee ID format' });
    }

    const [employeeDoc, leaveDoc, additionalInfoDoc] = await Promise.all([
      fetchDocument(ids.employeeId),
      fetchDocument(ids.leaveId),
      fetchDocument(ids.additionalInfoId)
    ]);

    res.status(200).json({
      employee: employeeDoc,
      leave: leaveDoc,
      additionalInfo: additionalInfoDoc
    });

  } catch (error) {
    console.error("Error fetching employee-related docs:", error.message);
    res.status(500).json({
      error: 'Failed to fetch related documents',
      details: error.message
    });
  }
});

// Helper: Transform employee data into paragraph
const transformToParagraph = (employeeData, additionalInfo, leaveData) => {
  const e = employeeData.data;
  const a = additionalInfo;
  const l = leaveData?.leaves || [];

  const leaveSummary = l.length
    ? `This employee has taken ${l.length} leaves on the following dates: ${l.map(i => i.date).join(', ')}.`
    : `This employee has not taken any leaves.`;

  return `
    ${e.FirstName} ${e.LastName} is a ${e.EmployeeType} ${e.DepartmentType} in the ${e.Division} division.
    They report to ${e.Manager} and started on ${e.StartDate}. 
    Their email is ${e.Email} and they work in ${e.PayZone}. 
    The employee status is ${e.EmployeeStatus}. 
    Additional info: Born on ${a.DOB}, resides in ${a.State}, gender: ${a.GenderCode}, marital status: ${a.MaritalDesc}, 
    rating: ${a["Current Employee Rating"]}, performance: ${a["Performance Score"]}.
    ${leaveSummary}
  `.replace(/\s+/g, ' ').trim();
};

// Route: /generate-embedding
app.post('/generate-embedding', async (req, res) => {
  const { doc_id } = req.body;

  try {
    // Fetch documents
    const employee = await fetchDocument(doc_id);
    const additionalId = `additionalinfo_${employee.data.additionalinfo_id}`;
    const leaveId = `leave_${employee.data.EmpID}`;

    const additionalInfo = await fetchDocument(additionalId);
    let leaveData = {};
    try {
      leaveData = await fetchDocument(leaveId);
    } catch (e) {
      console.warn(`Leave data not found for ${leaveId}`);
    }

    // Convert to paragraph
    const paragraph = transformToParagraph(employee, additionalInfo, leaveData);

    // Generate embedding using Gemini
    const model = genAI.getGenerativeModel({ model: 'embedding-001' });
    const result = await model.embedContent(paragraph);
    const embedding = result.embedding;

    res.status(200).json({ paragraph, embedding });
  } catch (err) {
    console.error("Embedding error:", err.message);
    res.status(500).json({ error: 'Failed to generate embedding', details: err.message });
  }
});


// Add this at the end of your file

const { Readable } = require('stream');
const chromadb = require("chromadb");

const client = new chromadb.ChromaClient({
  baseUrl: "http://localhost:8000", // Correctly pointing to the Chroma server
});

 // Use ChromaClient instead of calling chromadb()
console.log(client);
  // Create a client instance
const collection = client.createCollection('employee_embeddings'); // Create a collection for embeddings

// Function to process changed document and update embedding
const processChange = async (docId) => {
  try {
    const empMatch = docId.match(employeeRegex);
    const addMatch = docId.match(additionalinfoRegex);
    const leaveMatch = docId.match(leaveRegex);

    let empId = null;

    if (empMatch) empId = empMatch[1];
    if (addMatch) empId = addMatch[1];
    if (leaveMatch) empId = leaveMatch[1];

    if (!empId) return;

    const employeeDoc = await fetchDocument(`employee_1_${empId}`);
    const additionalDoc = await fetchDocument(`additionalinfo_1_${empId}`);
    const leaveDoc = await fetchDocument(`leave_${empId}`);

    let paragraph = `${employeeDoc.data.FirstName} ${employeeDoc.data.LastName} is a ${employeeDoc.data.EmployeeType} ${employeeDoc.data.DepartmentType} in the ${employeeDoc.data.Division} division. They report to ${employeeDoc.data.Manager} and started on ${employeeDoc.data.StartDate}. Their email is ${employeeDoc.data.Email} and they work in ${employeeDoc.data.PayZone}. The employee status is ${employeeDoc.data.EmployeeStatus}. Additional info: Born on ${additionalDoc.DOB}, resides in ${additionalDoc.State}, gender: ${additionalDoc.GenderCode}, marital status: ${additionalDoc.MaritalDesc}, rating: ${additionalDoc["Current Employee Rating"]}, performance: ${additionalDoc["Performance Score"]}.`;

    if (leaveDoc?.leaves?.length) {
      const leaveDates = leaveDoc.leaves.map(l => l.date).join(', ');
      paragraph += ` This employee has taken ${leaveDoc.leaves.length} leaves on the following dates: ${leaveDates}.`;
    }

    // Generate embedding
    const model = genAI.getGenerativeModel({ model: 'embedding-001' });
    const embeddingResult = await model.embedContent(paragraph);
    const embedding = embeddingResult.embedding;

    console.log(`📦 Updated embedding for employee ${empId}`);
    console.log("Embedding values (truncated):", embedding.values.slice(0, 5), "...");

    // Store the embedding in Chroma
    const metadata = {
      empId: empId,
      docId: docId,
      paragraph: paragraph,
    };

    // Store the embedding with metadata
    await collection.add({
      ids: [empId], // Unique ID (can be the empId)
      embeddings: [embedding.values], // Embedding values
      metadatas: [metadata], // Metadata for the document
    });

    console.log(`📦 Embedding for employee ${empId} stored in Chroma.`);
  } catch (err) {
    console.error(`❌ Error processing change for doc ${docId}:`, err.message);
  }
};

// Listen to CouchDB changes
const listenToCouchDB = () => {
  console.log('🔁 Starting CouchDB _changes listener...');

  const changesURL = `${COUCHDB_URL}/${DATABASE_NAME}/_changes?feed=continuous&include_docs=false&since=now`;
  const req = https.get(changesURL, {
    auth: `${COUCHDB_USERNAME}:${COUCHDB_PASSWORD}`,
    rejectUnauthorized: false,
  }, (res) => {
    const stream = new Readable().wrap(res);

    stream.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const change = JSON.parse(line);
            if (change.id) {
              processChange(change.id);
            }
          } catch (err) {
            console.error('Error parsing change line:', err.message);
          }
        }
      }
    });

    stream.on('end', () => {
      console.log('🔁 CouchDB _changes stream ended. Restarting...');
      setTimeout(listenToCouchDB, 2000);
    });
  });

  req.on('error', (err) => {
    console.error('❌ Error with _changes stream:', err.message);
    setTimeout(listenToCouchDB, 5000); // retry after delay
  });
};

// Start listening
listenToCouchDB();


// Root route
app.get('/', (req, res) => {
  res.send('Hello from Node.js!');
});

// Start server
const PORT = process.env.PORT || 3000;
console.log('Starting Express server...');
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
}).on('error', (error) => {
  console.error('Error starting server:', error);
});
