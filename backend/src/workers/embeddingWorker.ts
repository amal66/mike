import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../lib/queue/connection";
import {
    EMBEDDING_QUEUE,
    type EmbeddingJobData,
} from "../lib/queue/embeddingQueue";
import { runEmbeddingIngestion } from "../lib/rag/ingest";

/**
 * In-process BullMQ worker that runs the chunk+embed ingestion for one document
 * version. Mirrors conversionWorker / extractionWorker: the job body just calls
 * the dependency-injected core (runEmbeddingIngestion), which is what the unit
 * tests exercise directly without a live queue.
 */

/** True once a job has exhausted its retries (BullMQ 'failed', no attempts left). */
export function isPermanentFailure(job: Job<EmbeddingJobData>): boolean {
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsMade >= maxAttempts;
}

let worker: Worker<EmbeddingJobData> | null = null;

export function createEmbeddingWorker(): Worker<EmbeddingJobData> {
    if (worker) return worker;
    worker = new Worker<EmbeddingJobData>(
        EMBEDDING_QUEUE,
        async (job: Job<EmbeddingJobData>) => {
            const result = await runEmbeddingIngestion(job.data);
            console.log("[embedding-worker] ingestion finished", {
                jobId: job.id,
                documentId: job.data.documentId,
                versionId: job.data.versionId,
                result,
            });
        },
        {
            connection: getRedisConnection(),
            concurrency: 2,
            // Recover jobs orphaned by a worker crash mid-run.
            stalledInterval: 30_000,
            maxStalledCount: 2,
        },
    );
    worker.on("stalled", (jobId) => {
        console.warn("[embedding-worker] job stalled; will be re-queued", { jobId });
    });
    worker.on("failed", (job, err) => {
        if (!job) {
            console.error("[embedding-worker] job failed (no job)", { err });
            return;
        }
        if (!isPermanentFailure(job)) {
            console.error(
                "[embedding-worker] job failed (will retry, attempts remain)",
                { jobId: job.id, err },
            );
            return;
        }
        // No terminal DB flip needed: the document stays usable, semantic search
        // just misses this version until the next edit or a backfill re-enqueues.
        console.error(
            "[embedding-worker] job permanently failed; version left unindexed",
            {
                jobId: job.id,
                documentId: job.data.documentId,
                versionId: job.data.versionId,
                err,
            },
        );
    });
    return worker;
}

export async function stopEmbeddingWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
    }
}
