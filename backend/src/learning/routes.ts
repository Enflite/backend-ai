/**
 * learning/routes.ts — aggregates the learning-flywheel route plugins
 * (ADR-015): feedback capture, dataset curation, fine-tune jobs.
 * Registered once in server.ts as `learningRoutes`.
 */
import { FastifyInstance } from 'fastify';
import { feedbackRoutes } from './feedbackRoutes.js';
import { datasetRoutes } from './datasetRoutes.js';
import { finetuneJobRoutes } from './finetune/jobRoutes.js';

export async function learningRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(feedbackRoutes);
  await fastify.register(datasetRoutes);
  await fastify.register(finetuneJobRoutes);
}
