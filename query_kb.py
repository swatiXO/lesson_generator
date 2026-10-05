import os
import sys
import json
import argparse
import chromadb
from chromadb.utils import embedding_functions

# Set default embedding function (must match ingestion)
DEFAULT_EF = embedding_functions.DefaultEmbeddingFunction()

def main():
    parser = argparse.ArgumentParser(description="Query textbook knowledge base in ChromaDB.")
    parser.add_argument("--query", required=True, help="Search query")
    parser.add_argument("--grade", type=int, help="Filter by grade")
    parser.add_argument("--subject", help="Filter by subject")
    parser.add_argument("--limit", type=int, default=3, help="Max results to return")
    args = parser.parse_args()
    
    db_path = "./chroma_db"
    if not os.path.exists(db_path):
        # Database does not exist yet (no textbooks ingested)
        # Return empty list gracefully
        print(json.dumps([]))
        return
        
    try:
        client = chromadb.PersistentClient(path=db_path)
        collection = client.get_or_create_collection(
            name="textbooks", 
            embedding_function=DEFAULT_EF
        )
    except Exception as e:
        # Return error as json
        print(json.dumps({"error": f"Failed to connect to ChromaDB: {str(e)}"}))
        sys.exit(1)
        
    # Build where filter
    where_filter = {}
    # [FIX] Was `if args.grade:` — a truthy check that would silently skip
    # filtering if grade were ever 0 or any other falsy-but-valid value.
    # `is not None` is the correct check for "was this argument provided".
    if args.grade is not None:
        where_filter["grade"] = args.grade
    if args.subject:
        # Let's normalize subject
        subj = args.subject.lower()
        if "math" in subj:
            where_filter["subject"] = "Mathematics"
        elif "sci" in subj:
            where_filter["subject"] = "Science"
        elif "eng" in subj:
            where_filter["subject"] = "English"
        else:
            where_filter["subject"] = args.subject

    if len(where_filter) > 1:
        where = {"$and": [{k: v} for k, v in where_filter.items()]}
    elif len(where_filter) == 1:
        where = where_filter
    else:
        where = None
        
    try:
        results = collection.query(
            query_texts=[args.query],
            n_results=args.limit,
            where=where
        )
        
        # Format results
        output = []
        if results and "documents" in results and results["documents"]:
            docs = results["documents"][0]
            metas = results["metadatas"][0] if "metadatas" in results and results["metadatas"] else [None] * len(docs)
            distances = results["distances"][0] if "distances" in results and results["distances"] else [0.0] * len(docs)
            
            for i in range(len(docs)):
                meta = metas[i] or {}
                output.append({
                    "text": docs[i],
                    "source": meta.get("source", "Unknown"),
                    "page": meta.get("page", 0),
                    "grade": meta.get("grade", 0),
                    "subject": meta.get("subject", "Unknown"),
                    "slos": meta.get("slos", ""),
                    "distance": distances[i]
                })
                
        print(json.dumps(output))
        
    except Exception as e:
        print(json.dumps({"error": f"Query failed: {str(e)}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()