import { db, type Chunk } from "../src/db";
import { MODELS } from "../src/models";
import { embedChunks } from "../src/ingest";

const model = MODELS.embedMain.id;
const missing = () => db.query<Chunk & { corpus_id: string }, [string]>(`SELECT c.*,s.corpus_id
  FROM chunks c JOIN sources s ON s.id=c.source_id
  LEFT JOIN chunk_vectors v ON v.chunk_id=c.id AND v.model=?
  WHERE s.status='indexed' AND v.chunk_id IS NULL ORDER BY s.corpus_id,c.source_id,c.ordinal`).all(model);
try {
  const rows = missing(); let completed = 0;
  console.log(`Backfill: ${rows.length} missing chunks for ${model}`);
  for (let offset = 0; offset < rows.length; offset += 32) {
    completed += await embedChunks(rows.slice(offset, offset + 32));
    console.log(`Embedded ${completed}/${rows.length} chunks`);
  }
  const remaining = missing().length;
  const count = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM chunk_vectors WHERE model=?").get(model)!.n;
  console.log(`Backfill complete: ${completed} embedded; ${count} vectors for ${model}; ${remaining} missing`);
} catch (error) {
  console.error(`Backfill failed; safe to rerun: ${error instanceof Error ? error.message : "Embedding unavailable"}`);
  process.exitCode = 1;
} finally { db.close(); }
