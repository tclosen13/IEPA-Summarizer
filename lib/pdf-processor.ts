/**
 * PDF Text Extraction Library
 * Handles both native text extraction and OCR for scanned documents
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ExtractionResult {
  text: string;
  method: 'native' | 'ocr' | 'hybrid';
  pages: number;
  confidence?: number;
  warnings?: string[];
}

/**
 * Extract text from PDF using native text extraction
 */
export async function extractTextNative(pdfBuffer: Buffer): Promise<ExtractionResult | null> {
  try {
    // Dynamic import to avoid build issues
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(pdfBuffer);
    
    // Clean the extracted text
    const cleanText = data.text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
    
    // Check if we got meaningful content
    // Environmental docs typically have lots of text
    const wordCount = cleanText.split(/\s+/).filter(w => w.length > 2).length;
    
    if (wordCount > 50) {
      return {
        text: cleanText,
        method: 'native',
        pages: data.numpages,
      };
    }
    
    console.log(`Native extraction only found ${wordCount} words, likely scanned document`);
    return null;
    
  } catch (error) {
    console.error('Native PDF extraction error:', error);
    return null;
  }
}

/**
 * Extract text using OCR (Tesseract)
 * Converts PDF pages to images first
 */
export async function extractTextOCR(pdfBuffer: Buffer): Promise<ExtractionResult> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iepa-ocr-'));
  const pdfPath = path.join(tempDir, 'document.pdf');
  
  fs.writeFileSync(pdfPath, pdfBuffer);
  
  try {
    const Tesseract = await import('tesseract.js');
    
    // Get page count using pdf-parse
    let pageCount = 1;
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const pdfInfo = await pdfParse(pdfBuffer);
      pageCount = pdfInfo.numpages;
    } catch {
      console.log('Could not determine page count, assuming 1');
    }
    
    // For server-side PDF to image conversion, we need a different approach
    // Since we can't easily use canvas on server, we'll use a subprocess
    const { execSync } = await import('child_process');
    
    let allText = '';
    let totalConfidence = 0;
    let processedPages = 0;
    const maxPages = Math.min(pageCount, 25); // Limit for performance
    
    // Check if pdftoppm is available (from poppler-utils)
    let hasPdftoppm = false;
    try {
      execSync('which pdftoppm', { encoding: 'utf-8' });
      hasPdftoppm = true;
    } catch {
      console.log('pdftoppm not available, trying alternative methods');
    }
    
    if (hasPdftoppm) {
      // Convert PDF to images using pdftoppm
      const imagePrefix = path.join(tempDir, 'page');
      try {
        execSync(`pdftoppm -png -r 200 "${pdfPath}" "${imagePrefix}"`, {
          timeout: 120000, // 2 minute timeout
        });
        
        // Process each generated image
        const worker = await Tesseract.createWorker('eng');
        
        for (let i = 1; i <= maxPages; i++) {
          // pdftoppm names files as page-1.png, page-01.png, etc.
          const possiblePaths = [
            `${imagePrefix}-${i}.png`,
            `${imagePrefix}-${String(i).padStart(2, '0')}.png`,
            `${imagePrefix}-${String(i).padStart(3, '0')}.png`,
          ];
          
          let imagePath = '';
          for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
              imagePath = p;
              break;
            }
          }
          
          if (!imagePath) continue;
          
          try {
            const { data } = await worker.recognize(imagePath);
            allText += `\n\n--- Page ${i} ---\n${data.text}`;
            totalConfidence += data.confidence;
            processedPages++;
          } catch (pageError) {
            console.error(`OCR error on page ${i}:`, pageError);
          }
        }
        
        await worker.terminate();
      } catch (conversionError) {
        console.error('PDF to image conversion failed:', conversionError);
        throw new Error('PDF conversion failed - document may be encrypted or corrupted');
      }
    } else {
      // Fallback: Try using pdf.js with node-canvas
      console.log('Attempting pdf.js-based extraction...');
      
      // This is a simplified fallback - may not work without canvas
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(pdfBuffer);
      
      if (data.text && data.text.length > 0) {
        return {
          text: data.text,
          method: 'native',
          pages: data.numpages,
          warnings: ['OCR unavailable, using native extraction which may be incomplete'],
        };
      }
      
      throw new Error('OCR not available and native extraction failed');
    }
    
    if (processedPages === 0 || allText.length < 100) {
      throw new Error('OCR produced no meaningful text');
    }
    
    return {
      text: allText.trim(),
      method: 'ocr',
      pages: processedPages,
      confidence: totalConfidence / processedPages,
    };
    
  } finally {
    // Cleanup temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error('Temp cleanup error:', cleanupError);
    }
  }
}

/**
 * Main extraction function - tries native first, then OCR
 */
export async function extractText(pdfBuffer: Buffer): Promise<ExtractionResult> {
  // Validate PDF
  const header = pdfBuffer.slice(0, 8).toString();
  if (!header.startsWith('%PDF')) {
    throw new Error('Invalid PDF file');
  }
  
  // Try native extraction first
  const nativeResult = await extractTextNative(pdfBuffer);
  
  if (nativeResult && nativeResult.text.length > 500) {
    console.log(`Native extraction successful: ${nativeResult.text.length} chars`);
    return nativeResult;
  }
  
  // If native failed or got minimal text, try OCR
  console.log('Attempting OCR extraction...');
  
  try {
    const ocrResult = await extractTextOCR(pdfBuffer);
    
    // Combine results if we got partial native text
    if (nativeResult && nativeResult.text.length > 100) {
      return {
        text: `--- Native Text ---\n${nativeResult.text}\n\n--- OCR Text ---\n${ocrResult.text}`,
        method: 'hybrid',
        pages: ocrResult.pages,
        confidence: ocrResult.confidence,
      };
    }
    
    return ocrResult;
    
  } catch (ocrError) {
    // If OCR fails but we got some native text, return that
    if (nativeResult && nativeResult.text.length > 50) {
      return {
        ...nativeResult,
        warnings: ['OCR failed, using limited native extraction'],
      };
    }
    
    throw new Error(`Text extraction failed: ${ocrError}`);
  }
}

/**
 * Download PDF from URL with proper error handling
 */
export async function downloadPDF(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/pdf,*/*',
    },
    redirect: 'follow',
  });
  
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  
  const contentType = response.headers.get('content-type') || '';
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  // Verify it's a PDF
  const header = buffer.slice(0, 8).toString();
  if (!header.startsWith('%PDF')) {
    // Check if we got HTML instead (common for auth redirects)
    if (buffer.toString('utf-8', 0, 100).includes('<!DOCTYPE') || 
        buffer.toString('utf-8', 0, 100).includes('<html')) {
      throw new Error('Received HTML instead of PDF - URL may require authentication or has expired');
    }
    throw new Error(`Invalid PDF response (Content-Type: ${contentType})`);
  }
  
  return buffer;
}
