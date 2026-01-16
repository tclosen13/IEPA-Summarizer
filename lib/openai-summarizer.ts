/**
 * OpenAI-based Document Summarization
 * Specialized for environmental/LUST documents
 */

import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface DocumentSummary {
  documentId: string;
  date: string;
  type: string;
  siteContext: string;
  contaminantsOfConcern: string[];
  impactedMedia: string[];
  keyActions: string;
  relevanceFlag: 'Relevant' | 'Maybe' | 'Not Relevant';
  fullSummary: string;
}

export interface DocumentMetadata {
  id?: string;
  name?: string;
  date?: string;
  type?: string;
}

const SYSTEM_PROMPT = `You are an expert environmental consultant specializing in Illinois EPA LUST (Leaking Underground Storage Tank) documents, Site Remediation Program (SRP) files, and environmental due diligence.

Your task is to analyze environmental documents and produce structured summaries that help other consultants quickly assess relevance and key findings.

For each document, extract:

1. **Document Identification**: Document ID/number, date, and document type
2. **Site Context**: Facility name, address, former use, current status
3. **Contaminants of Concern**: Specific chemicals detected (BTEX, PAHs, MTBE, TPH, VOCs, SVOCs, metals like lead/arsenic, PCBs, etc.)
4. **Impacted Media**: Which environmental media are affected (soil, groundwater, soil vapor, surface water, sediment, indoor air)
5. **Key Actions/Status**: Tank removals, excavations, monitoring well installations, remediation systems, NFR letters, closure status, ongoing monitoring requirements
6. **Relevance Assessment**:
   - "Relevant" = Contains contamination data, remediation details, monitoring results, regulatory correspondence about cleanup, or closure documentation
   - "Maybe" = Administrative with some technical references (permits, invoices showing remediation costs, correspondence mentioning contamination)
   - "Not Relevant" = Purely administrative (blank forms, general correspondence, unrelated facility records)

Technical details to capture when present:
- Contaminant concentrations and comparison to standards (TACO Tier 1/2, RBCA, IEPA screening levels)
- Groundwater flow direction and monitoring well network
- Tank details (size, contents, removal dates, condition)
- Soil boring and monitoring well depths
- Remediation technology used (SVE, air sparging, pump & treat, excavation, in-situ treatment)
- Timeline and costs if mentioned
- Any remaining institutional controls or land use restrictions

Output must be valid JSON matching the specified schema.`;

export async function summarizeDocument(
  text: string,
  metadata: DocumentMetadata
): Promise<DocumentSummary> {
  const docId = metadata.name || metadata.id || 'Unknown Document';
  const docDate = metadata.date || 'Date Unknown';
  const docType = metadata.type || 'Type Unknown';

  // Truncate text to fit in context window (leaving room for response)
  const maxTextLength = 14000;
  const truncatedText = text.length > maxTextLength 
    ? text.substring(0, maxTextLength) + '\n\n[... Text truncated for processing ...]'
    : text;

  const userPrompt = `Analyze this environmental document and provide a structured summary.

Document Information:
- Name/ID: ${docId}
- Date: ${docDate}
- Type: ${docType}

Document Text:
---
${truncatedText}
---

Respond with valid JSON in this exact format:
{
  "documentId": "${docId}",
  "date": "${docDate}",
  "type": "${docType}",
  "siteContext": "2-3 sentences describing the facility, its history, and the document's purpose",
  "contaminantsOfConcern": ["List", "of", "specific", "contaminants"],
  "impactedMedia": ["soil", "groundwater", "etc"],
  "keyActions": "Summary of remediation activities, monitoring, or regulatory status",
  "relevanceFlag": "Relevant|Maybe|Not Relevant",
  "fullSummary": "Comprehensive ~200 word summary paragraph covering all key findings"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      temperature: 0.2, // Lower temperature for more consistent extraction
    });

    const content = response.choices[0].message.content;
    
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const parsed = JSON.parse(content);
    
    // Validate and normalize the response
    return {
      documentId: parsed.documentId || docId,
      date: parsed.date || docDate,
      type: parsed.type || docType,
      siteContext: parsed.siteContext || 'No site context extracted',
      contaminantsOfConcern: Array.isArray(parsed.contaminantsOfConcern) 
        ? parsed.contaminantsOfConcern 
        : [],
      impactedMedia: Array.isArray(parsed.impactedMedia) 
        ? parsed.impactedMedia 
        : [],
      keyActions: parsed.keyActions || 'No key actions identified',
      relevanceFlag: ['Relevant', 'Maybe', 'Not Relevant'].includes(parsed.relevanceFlag)
        ? parsed.relevanceFlag
        : 'Maybe',
      fullSummary: parsed.fullSummary || 'Summary generation failed',
    };

  } catch (error: any) {
    console.error('OpenAI summarization error:', error);
    
    // Return a structured error response
    return {
      documentId: docId,
      date: docDate,
      type: docType,
      siteContext: `Error processing document: ${error.message}`,
      contaminantsOfConcern: [],
      impactedMedia: [],
      keyActions: 'Could not extract due to processing error',
      relevanceFlag: 'Maybe',
      fullSummary: `Document processing encountered an error: ${error.message}. The document may need manual review.`,
    };
  }
}

/**
 * Generate a facility-level overview from multiple document summaries
 */
export async function generateFacilityOverview(
  facilityName: string,
  address: string,
  summaries: DocumentSummary[]
): Promise<string> {
  const relevantDocs = summaries.filter(s => s.relevanceFlag === 'Relevant');
  const allContaminants = [...new Set(relevantDocs.flatMap(s => s.contaminantsOfConcern))];
  const allMedia = [...new Set(relevantDocs.flatMap(s => s.impactedMedia))];

  // Get date range
  const dates = summaries
    .map(s => s.date)
    .filter(d => d && d !== 'Date Unknown' && d !== 'Unknown')
    .sort();
  
  const dateRange = dates.length > 1 
    ? `${dates[0]} to ${dates[dates.length - 1]}`
    : dates[0] || 'Unknown period';

  const prompt = `Write a 3-4 sentence facility overview for environmental due diligence based on these findings:

Facility: ${facilityName}
Address: ${address}
Documents Reviewed: ${summaries.length}
Relevant Documents: ${relevantDocs.length}
Date Range: ${dateRange}
Contaminants Identified: ${allContaminants.join(', ') || 'None specified'}
Media Affected: ${allMedia.join(', ') || 'None specified'}

Key findings from relevant documents:
${relevantDocs.map(d => `- ${d.siteContext}`).join('\n')}

Write a professional overview suitable for an environmental site assessment report.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.3,
    });

    return response.choices[0].message.content || 'Could not generate facility overview.';
  } catch (error) {
    console.error('Facility overview generation error:', error);
    return `${facilityName} at ${address}: Reviewed ${summaries.length} documents spanning ${dateRange}. ${relevantDocs.length} documents contained relevant environmental information. Contaminants identified include ${allContaminants.join(', ') || 'none specified'}, affecting ${allMedia.join(', ') || 'unspecified media'}.`;
  }
}
