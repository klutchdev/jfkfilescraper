import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import readlineSync from 'readline-sync';
import { fileURLToPath } from 'url';

const BASE_URL = 'https://www.archives.gov/research/jfk/release-2025';

// Convert `__dirname` for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const INDEX_FILE = path.join(DOWNLOAD_DIR, 'index.json');
const CHECKSUM_FILE = path.join(DOWNLOAD_DIR, 'checksums.json');

// Ensure necessary folders exist
fs.ensureDirSync(DOWNLOAD_DIR);

function log(msg) {
  console.log(msg);
}

// Scrape the JFK Archives Page for PDF Links
async function getPdfLinks() {
  try {
    log('\n📡 Fetching page...');

    const { data } = await axios.get(BASE_URL);
    const $ = cheerio.load(data);
    const links = [];

    $("table a[href$='.pdf']").each((_, el) => {
      let pdfUrl = $(el).attr('href');
      if (pdfUrl.startsWith('/')) {
        pdfUrl = `https://www.archives.gov${pdfUrl}`;
      }
      links.push(pdfUrl);
    });

    log(`✅ Found ${links.length} PDFs.`);
    return links;
  } catch (error) {
    console.error('❌ Error fetching page:', error.message);
    return [];
  }
}

// Estimate Total File Size Before Downloading
async function estimateTotalSize() {
  const pdfLinks = await getPdfLinks();
  let totalBytes = 0;

  log('\n📊 Estimating file sizes...');

  for (let i = 0; i < pdfLinks.length; i++) {
    try {
      const response = await axios.head(pdfLinks[i]);
      const size = parseInt(response.headers['content-length'], 10) || 0;
      totalBytes += size;
      log(`[${i + 1}/${pdfLinks.length}] ${(size / 1e6).toFixed(2)} MB`);
    } catch (error) {
      console.error(`⚠️ Couldn't fetch size for: ${pdfLinks[i]}`);
    }
  }

  log('\n===============================');
  log(`📊 Estimated Total Data Size: ${(totalBytes / 1e6).toFixed(2)} MB`);
  log('===============================\n');
}

// Organize PDFs into Batch Folders (500 per folder)

function getBatchFolder(idx) {
  const batchSize = 500;
  const batchNumber = Math.floor(idx / batchSize) + 1;
  const batchFolder = path.join(DOWNLOAD_DIR, `Batch_${batchNumber}`);
  fs.ensureDirSync(batchFolder);
  return batchFolder;
}

function generateChecksum(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    } catch (error) {
      reject(error);
    }
  });
}

// Download a Single PDF & Generate Checksum
async function downloadPdf(url, idx, indexData, checksums) {
  const fileName = path.basename(url);
  const batchFolder = getBatchFolder(idx);
  const filePath = path.join(batchFolder, fileName);

  if (fs.existsSync(filePath)) {
    log(`✅ [SKIP] ${fileName} already exists.`);
    return;
  }

  log(`📥 [${idx}] Downloading: ${fileName}`);

  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    log(`✅ [DONE] ${fileName}`);

    // Generate MD5 checksum after download
    const checksum = await generateChecksum(filePath);
    checksums[fileName] = checksum;

    // Add file details to index
    indexData.push({ fileName, url, size: fs.statSync(filePath).size, checksum });

    // Save checksums to file
    fs.writeJsonSync(CHECKSUM_FILE, checksums, { spaces: 2 });
  } catch (error) {
    console.error(`❌ [ERROR] Failed to download ${fileName}:`, error.message);
  }
}

// Download All PDFs (5 at a Time)
async function downloadAllPdfs() {
  const pdfLinks = await getPdfLinks();
  const indexData = [];
  const CHUNK_SIZE = 5;
  let checksums = {};

  // Load existing checksums if available
  if (fs.existsSync(CHECKSUM_FILE)) {
    checksums = fs.readJsonSync(CHECKSUM_FILE);
  }

  for (let i = 0; i < pdfLinks.length; i += CHUNK_SIZE) {
    const chunk = pdfLinks
      .slice(i, i + CHUNK_SIZE)
      .map((url, idx) => downloadPdf(url, i + idx + 1, indexData, checksums));
    await Promise.all(chunk);
  }

  // Save the index file
  fs.writeJsonSync(INDEX_FILE, indexData, { spaces: 2 });

  log('\n✅ All PDFs downloaded and integrity checksums saved!');
}

// Verify File Integrity
async function verifyChecksums() {
  if (!fs.existsSync(CHECKSUM_FILE)) {
    log('❌ No checksums found. Run a download first.');
    return;
  }

  const checksums = fs.readJsonSync(CHECKSUM_FILE);
  let corruptedFiles = [];

  log('\n🔍 Verifying file integrity...');

  for (const [fileName, originalHash] of Object.entries(checksums)) {
    // Look for the file inside batch folders
    const batchFolders = fs
      .readdirSync(DOWNLOAD_DIR)
      .filter((folder) => folder.startsWith('Batch_'));
    let filePath = null;

    for (const batchFolder of batchFolders) {
      const possiblePath = path.join(DOWNLOAD_DIR, batchFolder, fileName);
      if (fs.existsSync(possiblePath)) {
        filePath = possiblePath;
        break; // Stop looking once we find the file
      }
    }

    if (!filePath) {
      log(`⚠️ Missing file: ${fileName}`);
      corruptedFiles.push(fileName);
      continue;
    }

    const newHash = await generateChecksum(filePath);

    if (newHash !== originalHash) {
      log(`❌ [CORRUPTED] ${fileName}`);
      corruptedFiles.push(fileName);
    } else {
      log(`✅ [OK] ${fileName}`);
    }
  }

  log('\n🔎 Verification Complete!');

  if (corruptedFiles.length > 0) {
    log('⚠️ Some files are corrupted or missing!');
  } else {
    log('🎉 All files are intact!');
  }
}

async function mainMenu() {
  log('\n===============================');
  log('📂 JFK File Scraper');
  log('===============================');
  log('1️⃣  Calculate download storage size');
  log('2️⃣  Download all PDFs (5 at a time)');
  log('3️⃣  Verify file integrity');
  log('4️⃣  Exit');
  log('===============================\n');

  const choice = readlineSync.question('Choose an option: \n');

  switch (choice) {
    case '1':
      await estimateTotalSize();
      break;
    case '2':
      await downloadAllPdfs();
      break;
    case '3':
      await verifyChecksums();
      break;
    case '4':
      log('👋 Exiting... Enjoy your archive!');
      process.exit(0);
    default:
      log('❌ Invalid option. Please choose again.');
  }

  mainMenu();
}

mainMenu();
