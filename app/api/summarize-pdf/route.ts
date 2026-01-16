import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { extractTextFromPDF } from '@/lib/pdf-processor';

const getOpenAI = () => new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    console.log(`Processing uploaded file: ${file.name}`);

    // Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Extract text from PDF
    console.log('Extracting text from PDF...');
    let text = '';
    try {
      text = await extractTextFromPDF(buffer);
    } catch (e) {
      console.error('PDF extraction error:', e);
      return NextResponse.json({ error: 'Failed to extract text from PDF' }, { status: 500 });
    }

    if (!text || text.trim().length < 50) {
      return NextResponse.json({ 
        error: 'Could not extract sufficient text from PDF. It may be a scanned image.',
        summary: {
          documentId: file.name,
          date: 'Unknown',
          type: 'Unknown',
          siteContext: 'Could not extract text - may be scanned document',
          contaminantsOfConcern: [],
          impactedMedia: [],
          keyActions: 'Manual review required',
          relevanceFlag: 'Maybe',
          fullSummary: 'This document could not be processed automatically. It may be a scanned image that requires OCR.',
        }
      }, { status: 200 });
    }

    console.log(`Extracted ${text.length} characters, summarizing...`);

    // Summarize with OpenAI
    const openai = getOpenAI();
    
    const systemPrompt = `You are an environmental consultant analyzing IEPA (Illinois EPA) documents related to LUST (Leaking Underground Storage Tank) sites. 

Your task is to extract key information and provide a structured summary.

Respond in JSON format with these fields:
{
  "documentId": "filename or document identifier",
  "date": "document date if found",
  "type": "document type (e.g., Site Investigation Report, Corrective Action Plan, No Further Remediation Letter, Correspondence, etc.)",
  "siteContext": "brief description of the site and situation",
  "contaminantsOfConcern": ["list", "of", "contaminants"],
  "impactedMedia": ["soil", "groundwater", "etc"],
  "keyActions": "what actions were taken or recommended",
  "relevanceFlag": "Relevant|Maybe|Not Relevant",
  "fullSummary": "2-3 paragraph comprehensive summary"
}

Relevance flags:
- "Relevant": Contains significant findings about contamination, remediation status, or regulatory decisions
- "Maybe": Contains some useful information but not critical
- "Not Relevant": Administrative, routine correspondence, or unrelated to environmental conditions`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze this IEPA document and provide a structured summary:\n\n${text.substring(0, 15000)}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from OpenAI');
    }

    const summary = JSON.parse(content);
    summary.documentId = summary.documentId || file.name;

    console.log(`Summary generated for ${file.name}`);

    return NextResponse.json({ summary });

  } catch (error: any) {
    console.error('Summarize PDF error:', error);
    return NextResponse.json({ 
      error: error.message || 'Failed to process PDF' 
    }, { status: 500 });
  }
}
