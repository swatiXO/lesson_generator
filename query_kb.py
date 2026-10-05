import os
import sys
import json
import argparse
import chromadb
from chromadb.utils import embedding_functions

# Must match the embedding function used by ingest.py
DEFAULT_EF = embedding_functions.DefaultEmbeddingFunction()

# Resolved from this file, not the caller's working directory
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_db")


def normalize_subject(subject):
    subj = subject.lower()
    if "math" in subj:
        return "Mathematics"
    if "sci" in subj:
        return "Science"
    if "eng" in subj:
        return "English"
    return subject


def build_where(grade, subject):
    where_filter = {}
    if grade is not None:
        where_filter["grade"] = grade
    if subject:
        where_filter["subject"] = normalize_subject(subject)

    if len(where_filter) > 1:
        return {"$and": [{k: v} for k, v in where_filter.items()]}
    return where_filter or None


def format_results(results, index):
    output = []
    if not results or not results.get("documents"):
        return output
    docs = results["documents"][index]
    metas = results["metadatas"][index] if results.get("metadatas") else [None] * len(docs)
    distances = results["distances"][index] if results.get("distances") else [0.0] * len(docs)

    for doc, meta, distance in zip(docs, metas, distances):
        meta = meta or {}
        output.append({
            "text": doc,
            "source": meta.get("source", "Unknown"),
            "page": meta.get("page", 0),
            "grade": meta.get("grade", 0),
            "subject": meta.get("subject", "Unknown"),
            "slos": meta.get("slos", ""),
            "distance": distance,
        })
    return output


def main():
    parser = argparse.ArgumentParser(description="Query textbook knowledge base in ChromaDB.")
    parser.add_argument("--query", required=True, action="append",
                        help="Search query; repeat to run several queries in one process")
    parser.add_argument("--grade", type=int, help="Filter by grade")
    parser.add_argument("--subject", help="Filter by subject")
    parser.add_argument("--limit", type=int, default=3, help="Max results per query")
    args = parser.parse_args()

    # A single --query prints a flat list (original format); several print a list per query.
    batch = len(args.query) > 1

    if not os.path.exists(DB_PATH):
        # No textbooks ingested yet
        print(json.dumps([[] for _ in args.query] if batch else []))
        return

    try:
        client = chromadb.PersistentClient(path=DB_PATH)
        collection = client.get_or_create_collection(name="textbooks", embedding_function=DEFAULT_EF)
    except Exception as e:
        print(json.dumps({"error": f"Failed to connect to ChromaDB: {str(e)}"}))
        sys.exit(1)

    try:
        results = collection.query(
            query_texts=args.query,
            n_results=args.limit,
            where=build_where(args.grade, args.subject),
        )
        per_query = [format_results(results, i) for i in range(len(args.query))]
        print(json.dumps(per_query if batch else per_query[0]))
    except Exception as e:
        print(json.dumps({"error": f"Query failed: {str(e)}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
