"""skolia-ingest's analysis container: analyses a document's text into its blob.

The API stores the text at doc/{doc}/text.txt and starts an ingest run for the document
(ingest/src/workflow.ts), which POSTs the job here (http.py) and writes the document's
status from the answer. The worker (worker.py) writes the analysis, Brotli-compressed
JSON, beside the text. Blobs are read and written through the ingest Worker's R2 binding
(blobs.py, ingest/src/main.ts).
"""
