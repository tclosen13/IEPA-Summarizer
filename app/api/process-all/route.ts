// app/api/process-all/route.ts
// Main endpoint: Search facility → Get documents → Download → Summarize all

import { NextRequest, NextResponse } from 'next/server';
import { getScraper, closeScraper, FacilityResult, DocumentInfo } from '@/lib/iepa-scraper';
import OpenAI from 'openai';

export const maxDuration = 300; // 5 minutes max for full processing

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface ProcessingStatus {
  stage: string;
  progress: number;
  message: string;
}

interface DocumentSummary {
  documentId: string;
  date: string;
  type: string;
  siteContext: string;
  contaminantsOfConcern: string[];
  impactedMedia: string[];
  keyActions: string;
  relevanceFlag: 'Relevant' | 'Maybe' | 'Not Relevant';
  fullSummary: string;
  error?: string;
}

interface ProcessingResult {
  facility: FacilityResult;
  overview: string;
  documentsFound: number;
  documentsProcessed: number;
  summaries: DocumentSummary[];
  errors: string[];
}

const SYSTEM_PROMPT = `You are an expert environmental consultant specializing in Illinois EPA LUST (Leaking Underground Storage Tank) documents.

Analyze the document and extract:
1. Site Context: Facility name, address, history
2. Contaminants: BTEX, PAHs, MTBE, TPH, VOCs, metals, etc.
3. Impacted Media: Soil, groundwater, vapor, etc.
4. Key Actions: Tank removals, remediation, monitoring, closure
5. Relevance: "Relevant" (contamination/remediation data), "Maybe" (administrative with technical refs), "Not Relevant" (purely administrative)

Output valid JSON only.`;

async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(pdfBuffer);
    
    const text = data.text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
    
    if (text.length > 100) {
      return text;
    }

    // If very little text, try OCR
    console.log('Native extraction minimal, attempting OCR...');
    return await performOCR(pdfBuffer);

  } catch (error) {
    console.error('PDF extraction error:', error);
    throw error;
  }
}

async function performOCR(pdfBuffer: Buffer): Promise<string> {
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  const { execSync } = await import('child_process');
  const Tesseract = await import('tesseract.js');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iepa-'));
  const pdfPath = path.join(tempDir, 'input.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);

  try {
    // Convert PDF to images
    const imagePrefix = path.join(tempDir, 'page');
    execSync(`pdftoppm -png -r 150 "${pdfPath}" "${imagePrefix}"`, { timeout: 60000 });

    const files = fs.readdirSync(tempDir).filter(f => f.endsWith('.png')).sort();
    
    if (files.length === 0) {
      throw new Error('No images generated from PDF');
    }

    const worker = await Tesseract.createWorker('eng');
    let allText = '';
    const maxPages = Math.min(files.length, 15);

    for (let i = 0; i < maxPages; i++) {
      const { data } = await worker.recognize(path.join(tempDir, files[i]));
      allText += `\n--- Page ${i + 1} ---\n${data.text}`;
    }

    await worker.terminate();
    fs.rmSync(tempDir, { recursive: true, force: true });

    return allText.trim();

  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function summarizeDocument(
  text: string,
  doc: DocumentInfo
): Promise<DocumentSummary> {
  const maxLen = 12000;
  const truncated = text.length > maxLen ? text.substring(0, maxLen) + '\n[truncated]' : text;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Analyze this IEPA document:

Document Type: ${doc.type}
Date: ${doc.date}
Category: ${doc.category}

Text:
${truncated}

Respond with JSON:
{
  "documentId": "${doc.id}",
  "date": "${doc.date}",
  "type": "${doc.type}",
  "siteContext": "2-3 sentences",
  "contaminantsOfConcern": ["list"],
  "impactedMedia": ["list"],
  "keyActions": "summary",
  "relevanceFlag": "Relevant|Maybe|Not Relevant",
  "fullSummary": "200-word summary"
}`,
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
      temperature: 0.2,
    });

    const content = response.choices[0].message.content;
    if (!content) throw new Error('Empty response');

    const parsed = JSON.parse(content);

    return {
      documentId: parsed.documentId || doc.id,
      date: parsed.date || doc.date,
      type: parsed.type || doc.type,
      siteContext: parsed.siteContext || 'No context extracted',
      contaminantsOfConcern: Array.isArray(parsed.contaminantsOfConcern)
        ? parsed.contaminantsOfConcern
        : [],
      impactedMedia: Array.isArray(parsed.impactedMedia) ? parsed.impactedMedia : [],
      keyActions: parsed.keyActions || 'None identified',
      relevanceFlag: ['Relevant', 'Maybe', 'Not Relevant'].includes(parsed.relevanceFlag)
        ? parsed.relevanceFlag
        : 'Maybe',
      fullSummary: parsed.fullSummary || 'Summary unavailable',
    };
  } catch (error: any) {
    return {
      documentId: doc.id,
      date: doc.date,
      type: doc.type,
      siteContext: 'Processing error',
      contaminantsOfConcern: [],
      impactedMedia: [],
      keyActions: 'Error during processing',
      relevanceFlag: 'Maybe',
      fullSummary: `Error: ${error.message}`,
      error: error.message,
    };
  }
}

async function generateFacilityOverview(
  facility: FacilityResult,
  summaries: DocumentSummary[]
): Promise<string> {
  const relevant = summaries.filter((s) => s.relevanceFlag === 'Relevant');
  const contaminants = [...new Set(relevant.flatMap((s) => s.contaminantsOfConcern))];
  const media = [...new Set(relevant.flatMap((s) => s.impactedMedia))];

  const prompt = `Write a 3-4 sentence facility overview for environmental due diligence:

Facility: ${facility.name}
Address: ${facility.address}, ${facility.city}, IL ${facility.zip}
County: ${facility.county}
Documents Reviewed: ${summaries.length}
Relevant Documents: ${relevant.length}
Contaminants Found: ${contaminants.join(', ') || 'None identified'}
Media Affected: ${media.join(', ') || 'None identified'}

Write a professional summary suitable for a Phase I ESA report.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.3,
    });

    return response.choices[0].message.content || 'Overview generation failed.';
  } catch {
    return `${facility.name} at ${facility.address}, ${facility.city}, IL: ${summaries.length} documents reviewed, ${relevant.length} relevant. Contaminants: ${contaminants.join(', ') || 'none identified'}.`;
  }
}

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();
  let scraper = null;

  try {
    const { query, facilityId } = await request.json();

    if (!query && !facilityId) {
      return NextResponse.json(
        { error: 'Provide either a search query or facility ID' },
        { status: 400 }
      );
    }

    // Create a streaming response for progress updates
    const stream = new ReadableStream({
      async start(controller) {
        const sendUpdate = (data: any) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        try {
          scraper = await getScraper();

          // Step 1: Search or use provided facility ID
          let facility: FacilityResult;

          if (facilityId) {
            sendUpdate({ stage: 'search', progress: 100, message: 'Using provided facility ID' });
            facility = {
              id: facilityId,
              name: 'Selected Facility',
              address: '',
              city: '',
              county: '',
              zip: '',
              programs: [],
              link: '',
            };
          } else {
            sendUpdate({ stage: 'search', progress: 0, message: `Searching for "${query}"...` });
            const facilities = await scraper.searchFacilities(query);

            if (facilities.length === 0) {
              sendUpdate({ stage: 'error', message: 'No facilities found' });
              controller.close();
              return;
            }

            // Use the first result (could be improved with selection UI)
            facility = facilities[0];
            sendUpdate({
              stage: 'search',
              progress: 100,
              message: `Found: ${facility.name}`,
              facilities,
            });
          }

          // Step 2: Get documents
          sendUpdate({ stage: 'documents', progress: 0, message: 'Loading document list...' });
          const documents = await scraper.getFacilityDocuments(facility.id);
          sendUpdate({
            stage: 'documents',
            progress: 100,
            message: `Found ${documents.length} documents`,
            count: documents.length,
          });

          if (documents.length === 0) {
            sendUpdate({
              stage: 'complete',
              result: {
                facility,
                overview: 'No documents found for this facility.',
                documentsFound: 0,
                documentsProcessed: 0,
                summaries: [],
                errors: [],
              },
            });
            controller.close();
            return;
          }

          // Step 3: Download and summarize each document
          const summaries: DocumentSummary[] = [];
          const errors: string[] = [];
          const totalDocs = documents.length;

          for (let i = 0; i < totalDocs; i++) {
            const doc = documents[i];
            const progress = Math.round(((i + 1) / totalDocs) * 100);
            
            sendUpdate({
              stage: 'processing',
              progress,
              message: `Processing ${i + 1}/${totalDocs}: ${doc.type} (${doc.date})`,
              current: i + 1,
              total: totalDocs,
            });

            try {
              // Download document
              const downloaded = await scraper.downloadDocument(doc);
              
              if (!downloaded || !downloaded.pdfBuffer) {
                errors.push(`Could not download: ${doc.type} (${doc.date})`);
                continue;
              }

              // Extract text
              const text = await extractTextFromPdf(downloaded.pdfBuffer);
              
              if (!text || text.length < 50) {
                errors.push(`No text extracted: ${doc.type} (${doc.date})`);
                continue;
              }

              // Summarize
              const summary = await summarizeDocument(text, doc);
              summaries.push(summary);

              // Send partial result
              sendUpdate({
                stage: 'processing',
                progress,
                message: `Completed: ${doc.type} - ${summary.relevanceFlag}`,
                latestSummary: summary,
              });

            } catch (docError: any) {
              errors.push(`Error processing ${doc.type} (${doc.date}): ${docError.message}`);
            }
          }

          // Step 4: Generate facility overview
          sendUpdate({ stage: 'overview', progress: 0, message: 'Generating facility overview...' });
          const overview = await generateFacilityOverview(facility, summaries);

          // Final result
          const result: ProcessingResult = {
            facility,
            overview,
            documentsFound: totalDocs,
            documentsProcessed: summaries.length,
            summaries,
            errors,
          };

          sendUpdate({ stage: 'complete', progress: 100, result });
          controller.close();

        } catch (error: any) {
          sendUpdate({ stage: 'error', message: error.message });
          controller.close();
        } finally {
          // Don't close scraper - keep it for reuse
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error: any) {
    console.error('Process-all error:', error);
    return NextResponse.json(
      { error: 'Processing failed', message: error.message },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/process-all',
    method: 'POST',
    body: {
      query: 'Search term (facility name, address, etc.)',
      facilityId: 'Or provide a specific facility ID',
    },
    description: 'Searches IEPA, downloads all documents, and generates summaries',
  });
}
