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
          fullSu
