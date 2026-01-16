'use client';

import { useState, useCallback, useRef } from 'react';

interface FacilityResult {
  id: string;
  name: string;
  address: string;
  city: string;
  county: string;
  zip: string;
  programs: string[];
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

interface ProgressUpdate {
  stage: string;
  progress: number;
  message: string;
  facilities?: FacilityResult[];
  count?: number;
  current?: number;
  total?: number;
  latestSummary?: DocumentSummary;
  result?: ProcessingResult;
}

export default function Home() {
  const [query, setQuery] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [facilities, setFacilities] = useState<FacilityResult[]>([]);
  const [selectedFacility, setSelectedFacility] = useState<FacilityResult | null>(null);
  const [liveSummaries, setLiveSummaries] = useState<DocumentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'auto' | 'upload'>('auto');
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processQuery = useCallback(async (searchQuery: string, facilityId?: string) => {
    setIsProcessing(true);
    setError(null);
    setProgress(null);
    setResult(null);
    setLiveSummaries([]);
    
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch('/api/process-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          query: searchQuery,
          facilityId 
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data: ProgressUpdate = JSON.parse(line.slice(6));
              setProgress(data);

              if (data.facilities) {
                setFacilities(data.facilities);
              }

              if (data.latestSummary) {
                setLiveSummaries(prev => [...prev, data.latestSummary!]);
              }

              if (data.stage === 'error') {
                setError(data.message);
              }

              if (data.result) {
                setResult(data.result);
                setSelectedFacility(data.result.facility);
              }
            } catch (e) {
              console.error('Parse error:', e);
            }
          }
        }
      }

    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Processing failed');
      }
    } finally {
      setIsProcessing(false);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      processQuery(query.trim());
    }
  };

  const handleFacilitySelect = (facility: FacilityResult) => {
    setSelectedFacility(facility);
    setFacilities([]);
    processQuery('', facility.id);
  };

  const handleStop = () => {
    abortControllerRef.current?.abort();
    setIsProcessing(false);
  };

  // File upload handling
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const pdfFiles = files.filter(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    setUploadedFiles(prev => [...prev, ...pdfFiles]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    const pdfFiles = files.filter(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    setUploadedFiles(prev => [...prev, ...pdfFiles]);
  };

  const removeFile = (index: number) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const processUploadedFiles = async () => {
    if (uploadedFiles.length === 0) return;

    setIsUploading(true);
    setError(null);
    const newSummaries: DocumentSummary[] = [];

    for (let i = 0; i < uploadedFiles.length; i++) {
      const file = uploadedFiles[i];
      setProgress({
        stage: 'processing',
        progress: Math.round(((i + 1) / uploadedFiles.length) * 100),
        message: `Processing ${i + 1}/${uploadedFiles.length}: ${file.name}`,
        current: i + 1,
        total: uploadedFiles.length,
      });

      try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/api/summarize-pdf', {
          method: 'POST',
          body: formData,
        });

        if (response.ok) {
          const data = await response.json();
          if (data.summary) {
            newSummaries.push(data.summary);
            setLiveSummaries(prev => [...prev, data.summary]);
          }
        } else {
          console.error(`Failed to process ${file.name}`);
        }
      } catch (err) {
        console.error(`Error processing ${file.name}:`, err);
      }
    }

    setIsUploading(false);
    setUploadedFiles([]);
    setProgress(null);

    if (newSummaries.length > 0 && selectedFacility) {
      setResult(prev => ({
        facility: prev?.facility || selectedFacility,
        overview: prev?.overview || '',
        documentsFound: (prev?.documentsFound || 0) + newSummaries.length,
        documentsProcessed: (prev?.documentsProcessed || 0) + newSummaries.length,
        summaries: [...(prev?.summaries || []), ...newSummaries],
        errors: prev?.errors || [],
      }));
    }
  };

  const copyAllSummaries = () => {
    const summaries = result?.summaries || liveSummaries;
    if (summaries.length === 0) return;
    
    const text = `# IEPA Document Summary Report
${selectedFacility ? `## ${selectedFacility.name}
${selectedFacility.address}, ${selectedFacility.city}, IL ${selectedFacility.zip}
County: ${selectedFacility.county}` : ''}

Generated: ${new Date().toLocaleString()}

---

${result?.overview ? `## Facility Overview

${result.overview}

---

` : ''}## Document Summaries (${summaries.length})

${summaries.map((s, i) => `
### Document ${i + 1}: ${s.type}
**Date:** ${s.date}
**Relevance:** ${s.relevanceFlag}

**Site Context:** ${s.siteContext}

**Contaminants of Concern:** ${s.contaminantsOfConcern.join(', ') || 'None identified'}

**Impacted Media:** ${s.impactedMedia.join(', ') || 'None identified'}

**Key Actions:** ${s.keyActions}

**Summary:**
${s.fullSummary}
`).join('\n---\n')}
`;
    
    navigator.clipboard.writeText(text);
    alert('Report copied to clipboard!');
  };

  const relevantCount = (result?.summaries || liveSummaries).filter(s => s.relevanceFlag === 'Relevant').length;
  const maybeCount = (result?.summaries || liveSummaries).filter(s => s.relevanceFlag === 'Maybe').length;
  const notRelevantCount = (result?.summaries || liveSummaries).filter(s => s.relevanceFlag === 'Not Relevant').length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      {/* Header */}
      <header className="border-b border-slate-700 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                🏭 IEPA Document Summarizer
              </h1>
              <p className="text-sm text-slate-400">
                Automated environmental document analysis
              </p>
            </div>
            {(result?.summaries?.length || liveSummaries.length > 0) && (
              <button
                onClick={copyAllSummaries}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-medium transition-colors flex items-center gap-2"
              >
                📋 Copy Full Report
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Mode Toggle */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setMode('auto')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              mode === 'auto' 
                ? 'bg-emerald-600 text-white' 
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            🔍 Search IEPA
          </button>
          <button
            onClick={() => setMode('upload')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              mode === 'upload' 
                ? 'bg-emerald-600 text-white' 
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            📤 Upload PDFs
          </button>
        </div>

        {/* Auto Search Mode */}
        {mode === 'auto' && (
          <div className="bg-slate-800/50 rounded-2xl p-6 mb-8 border border-slate-700">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Search IEPA Document Explorer
                </label>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Enter facility name, address, city, ZIP, or IEPA ID..."
                    className="flex-1 px-4 py-3 bg-slate-900 border border-slate-600 rounded-xl text-white placeholder-slate-500 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    disabled={isProcessing}
                  />
                  {isProcessing ? (
                    <button
                      type="button"
                      onClick={handleStop}
                      className="px-6 py-3 bg-red-600 hover:bg-red-500 rounded-xl font-medium transition-colors"
                    >
                      ⏹ Stop
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!query.trim()}
                      className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 rounded-xl font-medium transition-colors"
                    >
                      🔍 Search
                    </button>
                  )}
                </div>
              </div>
              <p className="text-sm text-slate-500">
                Example: "LOSURDO BROTHERS" or "Gonzales Transfer" or "Chicago"
              </p>
            </form>
          </div>
        )}

        {/* Upload Mode */}
        {mode === 'upload' && (
          <div className="bg-slate-800/50 rounded-2xl p-6 mb-8 border border-slate-700">
            <h2 className="text-lg font-semibold mb-4">Upload PDF Documents</h2>
            <p className="text-sm text-slate-400 mb-4">
              Download PDFs from IEPA DocuWare manually, then upload them here for AI summarization.
            </p>
            
            {/* Drop zone */}
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-slate-600 rounded-xl p-8 text-center cursor-pointer hover:border-emerald-500 transition-colors"
            >
              <div className="text-4xl mb-2">📄</div>
              <p className="text-slate-300">Drop PDF files here or click to browse</p>
              <p className="text-sm text-slate-500 mt-1">Supports multiple files</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                multiple
                onChange={handleFileChange}
                className="hidden"
              />
            </div>

            {/* File list */}
            {uploadedFiles.length > 0 && (
              <div className="mt-4">
                <h3 className="text-sm font-medium text-slate-300 mb-2">
                  Files to process ({uploadedFiles.length})
                </h3>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {uploadedFiles.map((file, i) => (
                    <div key={i} className="flex items-center justify-between bg-slate-700/50 rounded-lg p-2">
                      <span className="text-sm truncate">{file.name}</span>
                      <button
                        onClick={() => removeFile(i)}
                        className="text-red-400 hover:text-red-300 ml-2"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  onClick={processUploadedFiles}
                  disabled={isUploading}
                  className="mt-4 w-full px-6 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 rounded-xl font-medium transition-colors"
                >
                  {isUploading ? '⏳ Processing...' : `🤖 Summarize ${uploadedFiles.length} PDFs`}
                </button>
              </div>
            )}

            {/* Tips */}
            <div className="mt-6 p-4 bg-slate-700/30 rounded-xl">
              <h3 className="font-medium text-emerald-400 mb-2">💡 How to download from DocuWare:</h3>
              <ol className="text-sm text-slate-400 space-y-1 list-decimal list-inside">
                <li>Go to IEPA Document Explorer and find your facility</li>
                <li>Click the document category to open DocuWare</li>
                <li>Right-click on the document icon (left side of row)</li>
                <li>Select "Download... as PDF without annotations"</li>
                <li>Upload the downloaded PDFs here</li>
              </ol>
            </div>
          </div>
        )}

        {/* Facility Selection */}
        {facilities.length > 1 && !isProcessing && (
          <div className="bg-slate-800/50 rounded-2xl p-6 mb-8 border border-slate-700">
            <h2 className="text-lg font-semibold mb-4">Select a Facility ({facilities.length} found)</h2>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {facilities.map((f) => (
                <button
                  key={f.id}
                  onClick={() => handleFacilitySelect(f)}
                  className="w-full text-left p-4 bg-slate-700/50 hover:bg-slate-600/50 rounded-xl transition-colors"
                >
                  <div className="font-medium">{f.name}</div>
                  <div className="text-sm text-slate-400">
                    {f.address}, {f.city}, {f.county} County {f.zip}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Progress */}
        {(isProcessing || isUploading) && progress && (
          <div className="bg-slate-800/50 rounded-2xl p-6 mb-8 border border-slate-700">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">
                {progress.stage === 'search' && '🔍 Searching...'}
                {progress.stage === 'documents' && '📄 Loading Documents...'}
                {progress.stage === 'processing' && '⚙️ Processing...'}
                {progress.stage === 'overview' && '📝 Generating Overview...'}
              </h2>
              <span className="text-emerald-400 font-mono">{progress.progress}%</span>
            </div>
            
            <div className="w-full bg-slate-700 rounded-full h-3 mb-4">
              <div
                className="bg-emerald-500 h-3 rounded-full transition-all duration-300"
                style={{ width: `${progress.progress}%` }}
              />
            </div>
            
            <p className="text-slate-400">{progress.message}</p>
          </div>
        )}

        {/* Error with helpful message */}
        {error && (
          <div className="bg-red-900/30 border border-red-700 rounded-2xl p-6 mb-8">
            <h2 className="text-lg font-semibold text-red-400 mb-2">Processing Issue</h2>
            <p className="mb-4">{error}</p>
            {error.includes('download') && (
              <div className="p-4 bg-slate-800/50 rounded-xl">
                <p className="text-emerald-400 font-medium mb-2">💡 Try the Upload method instead:</p>
                <ol className="text-sm text-slate-400 list-decimal list-inside space-y-1">
                  <li>Click the "Upload PDFs" tab above</li>
                  <li>Manually download PDFs from DocuWare (right-click → Download as PDF)</li>
                  <li>Upload them here for summarization</li>
                </ol>
              </div>
            )}
          </div>
        )}

        {/* Results */}
        {(liveSummaries.length > 0 || result) && (
          <div className="space-y-6">
            {/* Stats */}
            <div className="flex items-center gap-4 text-sm">
              <span className="px-3 py-1 bg-emerald-900/50 border border-emerald-700 rounded-lg">
                ✅ {relevantCount} Relevant
              </span>
              <span className="px-3 py-1 bg-yellow-900/50 border border-yellow-700 rounded-lg">
                ❓ {maybeCount} Maybe
              </span>
              <span className="px-3 py-1 bg-slate-700/50 border border-slate-600 rounded-lg">
                ⬜ {notRelevantCount} Not Relevant
              </span>
            </div>

            {/* Facility Overview */}
            {result && selectedFacility && (
              <div className="bg-emerald-900/20 border border-emerald-700/50 rounded-2xl p-6">
                <h2 className="text-xl font-bold mb-2">{selectedFacility.name}</h2>
                <p className="text-slate-400 mb-4">
                  {selectedFacility.address}, {selectedFacility.city}, IL {selectedFacility.zip}
                </p>
                {result.overview && (
                  <p className="text-slate-300 leading-relaxed">{result.overview}</p>
                )}
                <div className="mt-4 text-sm text-slate-500">
                  {result.documentsProcessed} documents summarized
                  {result.errors.length > 0 && ` • ${result.errors.length} errors`}
                </div>
              </div>
            )}

            {/* Summaries */}
            <h2 className="text-xl font-semibold">
              Document Summaries ({(result?.summaries || liveSummaries).length})
            </h2>

            <div className="space-y-4">
              {(result?.summaries || liveSummaries).map((summary, index) => (
                <div
                  key={index}
                  className={`rounded-2xl p-6 border ${
                    summary.relevanceFlag === 'Relevant'
                      ? 'bg-emerald-900/20 border-emerald-700/50'
                      : summary.relevanceFlag === 'Maybe'
                      ? 'bg-yellow-900/20 border-yellow-700/50'
                      : 'bg-slate-800/30 border-slate-700/50'
                  }`}
                >
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="font-semibold text-lg">{summary.type}</h3>
                      <p className="text-sm text-slate-400">{summary.date}</p>
                    </div>
                    <span
                      className={`px-3 py-1 rounded-full text-sm font-medium ${
                        summary.relevanceFlag === 'Relevant'
                          ? 'bg-emerald-600'
                          : summary.relevanceFlag === 'Maybe'
                          ? 'bg-yellow-600'
                          : 'bg-slate-600'
                      }`}
                    >
                      {summary.relevanceFlag}
                    </span>
                  </div>

                  <div className="grid md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <h4 className="text-xs font-semibold text-slate-500 uppercase mb-1">Site Context</h4>
                      <p className="text-sm text-slate-300">{summary.siteContext}</p>
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold text-slate-500 uppercase mb-1">Key Actions</h4>
                      <p className="text-sm text-slate-300">{summary.keyActions}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-4 mb-4">
                    <div>
                      <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">Contaminants</h4>
                      <div className="flex flex-wrap gap-1">
                        {summary.contaminantsOfConcern.length > 0 ? (
                          summary.contaminantsOfConcern.map((c, i) => (
                            <span key={i} className="px-2 py-0.5 bg-red-900/50 text-red-300 rounded text-xs">
                              {c}
                            </span>
                          ))
                        ) : (
                          <span className="text-slate-500 text-xs">None identified</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">Impacted Media</h4>
                      <div className="flex flex-wrap gap-1">
                        {summary.impactedMedia.length > 0 ? (
                          summary.impactedMedia.map((m, i) => (
                            <span key={i} className="px-2 py-0.5 bg-blue-900/50 text-blue-300 rounded text-xs">
                              {m}
                            </span>
                          ))
                        ) : (
                          <span className="text-slate-500 text-xs">None identified</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="bg-slate-900/50 rounded-xl p-4">
                    <p className="text-sm text-slate-300 leading-relaxed">{summary.fullSummary}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Errors */}
            {result && result.errors.length > 0 && (
              <div className="bg-red-900/20 border border-red-700/50 rounded-2xl p-6">
                <h3 className="font-semibold text-red-400 mb-2">
                  Processing Errors ({result.errors.length})
                </h3>
                <ul className="text-sm text-red-300 space-y-1">
                  {result.errors.map((err, i) => (
                    <li key={i}>• {err}</li>
                  ))}
                </ul>
                <p className="mt-4 text-sm text-slate-400">
                  💡 Tip: Try downloading these documents manually and using the Upload tab
                </p>
              </div>
            )}
          </div>
        )}

        {/* Empty State */}
        {!isProcessing && !result && liveSummaries.length === 0 && !error && facilities.length === 0 && (
          <div className="text-center py-16">
            <div className="text-6xl mb-4">📋</div>
            <h2 className="text-2xl font-bold mb-2">Ready to Analyze</h2>
            <p className="text-slate-400 max-w-md mx-auto mb-8">
              Search for a facility or upload PDF documents for AI-powered environmental analysis.
            </p>
            <div className="grid md:grid-cols-2 gap-4 max-w-2xl mx-auto text-left">
              <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
                <div className="text-2xl mb-2">🔍</div>
                <h3 className="font-semibold mb-1">Search Mode</h3>
                <p className="text-sm text-slate-400">Search IEPA Document Explorer by facility name</p>
              </div>
              <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
                <div className="text-2xl mb-2">📤</div>
                <h3 className="font-semibold mb-1">Upload Mode</h3>
                <p className="text-sm text-slate-400">Upload PDFs you've downloaded from DocuWare</p>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-slate-800 mt-12">
        <div className="max-w-6xl mx-auto px-4 py-6 text-center text-sm text-slate-500">
          <p>IEPA Document Summarizer v3.0 • Powered by OpenAI GPT-4</p>
        </div>
      </footer>
    </div>
  );
}
