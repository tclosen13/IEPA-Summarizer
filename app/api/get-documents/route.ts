// app/api/get-documents/route.ts
// Get all documents for a specific facility

import { NextRequest, NextResponse } from 'next/server';
import { getScraper, closeScraper } from '@/lib/iepa-scraper';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const { facilityId } = await request.json();

    if (!facilityId) {
      return NextResponse.json(
        { error: 'Facility ID is required' },
        { status: 400 }
      );
    }

    console.log(`Getting documents for facility: ${facilityId}`);

    const scraper = await getScraper();
    const documents = await scraper.getFacilityDocuments(facilityId);

    return NextResponse.json({
      success: true,
      facilityId,
      count: documents.length,
      documents,
    });

  } catch (error: any) {
    console.error('Get documents error:', error);
    await closeScraper();

    return NextResponse.json(
      { 
        error: 'Failed to get documents',
        message: error.message,
      },
      { status: 500 }
    );
  }
}
