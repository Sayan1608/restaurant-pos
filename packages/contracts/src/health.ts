import { z } from 'zod';

/** Liveness: the process is up. Must not touch any dependency. */
export const LivenessSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.string().datetime(),
});
export type Liveness = z.infer<typeof LivenessSchema>;

export const DependencyStatusSchema = z.object({
  name: z.string(),
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});
export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;

/** Readiness: the process can serve traffic. Checks every hard dependency. */
export const ReadinessSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  dependencies: z.array(DependencyStatusSchema),
  timestamp: z.string().datetime(),
});
export type Readiness = z.infer<typeof ReadinessSchema>;
