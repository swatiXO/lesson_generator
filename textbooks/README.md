# Textbook Directory
Place your curriculum textbook PDFs in this directory.

The ingestion script (`ingest.py`) will scan this directory for PDFs, parse them page-by-page, perform OCR on scanned pages, and save the embeddings to the ChromaDB database in the root of the project.
