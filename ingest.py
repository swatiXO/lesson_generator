import os
import re
import sys
import io
import argparse
from PIL import Image
import fitz  # PyMuPDF
import pytesseract
import chromadb
from chromadb.utils import embedding_functions

# Set default embedding function (uses all-MiniLM-L6-v2)
DEFAULT_EF = embedding_functions.DefaultEmbeddingFunction()

# Paths resolve from this file, not the caller's working directory
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

def parse_filename_metadata(filename):
    """
    Tries to guess Grade and Subject from the filename.
    Examples:
    - 'Grade4_Maths_Chapter1.pdf' -> grade=4, subject='Mathematics'
    - 'G5_Science.pdf' -> grade=5, subject='Science'
    - 'Grade10_Maths.pdf' -> grade=10, subject='Mathematics'
    - 'Grade07_Science.pdf' -> grade=7, subject='Science' (zero-padded)

    Grades 1-12, bare or zero-padded; the (?!\\d) lookahead stops a 3+ digit
    run (e.g. "Grade123") from matching.
    """
    name_lower = filename.lower()

    # Guess grade
    grade = None
    grade_match = re.search(r'(?:grade|class|g)[-_\s]*(1[0-2]|0?[1-9])(?!\d)', name_lower)
    if grade_match:
        grade = int(grade_match.group(1))
    else:
        # Loud on purpose: a silent default is how files get mistagged.
        grade = 4
        print(f"[!] WARNING: Could not detect grade from filename '{filename}'. "
              f"Defaulting to Grade {grade} — VERIFY THIS FILE'S ACTUAL GRADE and "
              f"rename it (e.g. 'Grade2_Maths_Chapter1.pdf') if this default is wrong, "
              f"then re-run ingestion for this file.")

    # Guess subject
    subject = "Mathematics"  # Default
    if "science" in name_lower or "sci" in name_lower:
        subject = "Science"
    elif "english" in name_lower or "eng" in name_lower:
        subject = "English"

    return grade, subject

def chunk_text(text, chunk_size=800, overlap=100):
    """
    Split text into overlapping chunks.
    """
    words = text.split()
    chunks = []
    i = 0
    while i < len(words):
        chunk_words = words[i:i + chunk_size]
        chunks.append(" ".join(chunk_words))
        i += chunk_size - overlap
        if len(words) - i < overlap:
            break
    return chunks

def ingest_pdf(file_path, collection, force_ocr=False):
    filename = os.path.basename(file_path)
    grade, subject = parse_filename_metadata(filename)
    
    print(f"[*] Processing {filename} (Inferred Grade: {grade}, Subject: {subject})...")
    
    try:
        doc = fitz.open(file_path)
    except Exception as e:
        print(f"[!] Error opening PDF {filename}: {e}")
        return
        
    total_pages = len(doc)
    print(f"[*] PDF has {total_pages} pages.")
    
    chunk_count = 0
    for page_num in range(total_pages):
        page = doc[page_num]
        
        # 1. Try to extract digital text
        text = page.get_text()
        is_scanned = len(text.strip()) < 100 or force_ocr
        
        if is_scanned:
            print(f"[*] Page {page_num + 1}/{total_pages} appears scanned. Running OCR...")
            try:
                # Render page to image
                pix = page.get_pixmap(dpi=150)
                img_data = pix.tobytes("png")
                img = Image.open(io.BytesIO(img_data))
                text = pytesseract.image_to_string(img)
            except Exception as e:
                print(f"[!] OCR failed on page {page_num + 1}: {e}")
                text = page.get_text()  # Fallback to whatever text PyMuPDF found
        else:
            print(f"[*] Page {page_num + 1}/{total_pages} extracted digitally.")
            
        text = text.strip()
        if not text:
            print(f"[-] Page {page_num + 1}/{total_pages} is empty. Skipping.")
            continue
            
        # Extract potential SLO codes (e.g. M-04-A-19 or S-05-B-02)
        # Matches pattern: Letter - 2 digits - Letter - 2 digits
        slo_codes = re.findall(r'\b[A-Za-z]-\d{2}-[A-Za-z]-\d{2}\b', text)
        slo_str = ",".join(list(set(slo_codes))) if slo_codes else ""
        
        # 2. Chunk text
        chunks = chunk_text(text)
        for idx, chunk in enumerate(chunks):
            if len(chunk.strip()) < 50:
                continue
                
            chunk_id = f"{filename}_p{page_num + 1}_c{idx}"
            metadata = {
                "source": filename,
                "page": page_num + 1,
                "grade": grade,
                "subject": subject,
                "slos": slo_str
            }
            
            # Write to ChromaDB
            collection.add(
                documents=[chunk],
                metadatas=[metadata],
                ids=[chunk_id]
            )
            chunk_count += 1
            
    print(f"[+] Completed {filename}: Added {chunk_count} chunks.")

def main():
    parser = argparse.ArgumentParser(description="Ingest textbook PDFs into ChromaDB.")
    parser.add_argument("--dir", default=os.path.join(PROJECT_DIR, "textbooks"),
                        help="Directory containing PDFs (default: ./textbooks next to this script)")
    parser.add_argument("--force-ocr", action="store_true", help="Force OCR on all pages")
    args = parser.parse_args()
    
    if not os.path.exists(args.dir):
        print(f"[!] Directory '{args.dir}' does not exist.")
        sys.exit(1)
        
    pdf_files = [os.path.join(args.dir, f) for f in os.listdir(args.dir) if f.endswith(".pdf")]
    
    if not pdf_files:
        print(f"[-] No PDF files found in '{args.dir}'. Place textbooks there first.")
        sys.exit(0)
        
    print(f"[*] Found {len(pdf_files)} PDFs to process.")
    
    # Initialize ChromaDB
    db_path = os.path.join(PROJECT_DIR, "chroma_db")  # must match query_kb.py
    print(f"[*] Opening ChromaDB at {db_path}...")
    try:
        client = chromadb.PersistentClient(path=db_path)
        collection = client.get_or_create_collection(
            name="textbooks", 
            embedding_function=DEFAULT_EF
        )
    except Exception as e:
        print(f"[!] Failed to connect to ChromaDB: {e}")
        sys.exit(1)
        
    for pdf in pdf_files:
        ingest_pdf(pdf, collection, force_ocr=args.force_ocr)
        
    print(f"[+] Ingestion complete. Total items in collection: {collection.count()}")

if __name__ == "__main__":
    main()