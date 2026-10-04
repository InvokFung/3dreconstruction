/**
 * Deterministic, time-based job simulation for the mock API.
 * A job's state is a pure function of its record and "now", so page reloads resume naturally.
 */

export const QUEUE_MS = 1500;

const TOTAL_MS = { draft: 12000, standard: 18000, high: 26000 };

const PHOTO_WEIGHTS = { ingest: 0.06, masking: 0.1, sfm: 0.2, depth: 0.18, fusion: 0.1, meshing: 0.12, cleanup: 0.06, texturing: 0.13, export: 0.05 };
const GEN_WEIGHTS = { ingest: 0.1, masking: 0.15, generate: 0.5, texturing: 0.17, export: 0.08 };

export function planJob({ engine = 'photogrammetry', options = {}, imageCount = 0 }) {
  const weights = engine === 'generative' ? GEN_WEIGHTS : PHOTO_WEIGHTS;
  const total = TOTAL_MS[options.quality] ?? TOTAL_MS.standard;
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  const stages = Object.entries(weights).map(([stage, w]) => ({ stage, ms: Math.round((w / sum) * total) }));
  let fail = null;
  if (imageCount < 3) {
    const aligned = Math.max(0, imageCount - 1);
    fail = {
      stage: 'sfm',
      at: 0.6,
      error: `Only ${aligned} of ${imageCount} images could be aligned. Take more overlapping photos.`,
    };
  }
  return { stages, total, fail };
}

function stageMessage(stage, frac, job) {
  const n = job.image_count || 1;
  const k = Math.max(1, Math.min(n, Math.ceil(frac * n)));
  const o = job.options ?? {};
  switch (stage) {
    case 'ingest':
      return `Reading ${n} files, extracting EXIF`;
    case 'masking':
      return o.mode === 'scene' ? 'Scene mode: background kept' : `Segmenting subject ${k}/${n}`;
    case 'sfm':
      return `Registered ${k}/${n} images`;
    case 'depth':
      return `Depth map ${k}/${n}`;
    case 'fusion':
      return `Fused ${(frac * 2.4).toFixed(1)}M points`;
    case 'meshing':
      return 'Screened Poisson reconstruction (depth 10)';
    case 'cleanup':
      return `Removing floaters, decimating to ${(o.target_faces ?? 100000).toLocaleString('en-US')} faces`;
    case 'texturing':
      return `Baking ${o.texture_size ?? 2048}px texture atlas`;
    case 'export':
      return 'Writing GLB, OBJ, PLY, USDZ';
    case 'generate':
      return `Sampling geometry, step ${Math.ceil(frac * 50)}/50`;
    default:
      return '';
  }
}

const LOG_LINES = {
  ingest: ['Found {n} inputs (0 videos)', 'Normalised orientation and colour space'],
  masking: ['Loaded segmentation model (u2net, cpu)', 'Median mask coverage 38%'],
  sfm: ['Extracted 8,192 SIFT features per image', 'Exhaustive matching: {pairs} pairs', 'Bundle adjustment converged, mean reprojection error 0.61px'],
  depth: ['PatchMatch stereo, 5 source views per reference', 'Filtered depth maps by geometric consistency'],
  fusion: ['Fused 2.41M points from {n} depth maps', 'Outlier removal: dropped 3.2% points'],
  meshing: ['Poisson depth 10, trimming density < 7', 'Raw mesh: 1.84M faces'],
  cleanup: ['Removed 14 disconnected components', 'Quadric decimation to {faces} faces'],
  texturing: ['UV atlas: 6 charts', 'Projected colour from {n} views with seam levelling'],
  export: ['Wrote model.glb, model_obj.zip, model.ply, model.usdz'],
  generate: ['Loaded generative model weights', 'Denoising 50 steps'],
};

/** Every log line the job will ever emit, with its offset (ms) from job creation. */
function allLogs(job, plan) {
  const out = [];
  let t = QUEUE_MS;
  out.push({ at: 200, level: 'info', message: `Job queued (engine=${job.engine}, quality=${job.options?.quality ?? 'standard'})` });
  out.push({ at: QUEUE_MS, level: 'info', message: 'Worker picked up job' });
  const n = job.image_count || 0;
  for (const { stage, ms } of plan.stages) {
    out.push({ at: t + 1, level: 'info', message: `[${stage}] started` });
    const lines = LOG_LINES[stage] ?? [];
    lines.forEach((line, i) => {
      const msg = line
        .replace('{n}', String(n))
        .replace('{pairs}', String((n * (n - 1)) / 2))
        .replace('{faces}', (job.options?.target_faces ?? 100000).toLocaleString('en-US'));
      out.push({ at: t + Math.round((ms * (i + 1)) / (lines.length + 1)), level: 'info', message: msg });
    });
    if (plan.fail?.stage === stage) {
      out.push({ at: t + Math.round(ms * plan.fail.at) - 1, level: 'warning', message: 'Too few verified matches between image pairs' });
      out.push({ at: t + Math.round(ms * plan.fail.at), level: 'error', message: plan.fail.error });
      break;
    }
    out.push({ at: t + ms - 1, level: 'info', message: `[${stage}] done in ${(ms / 1000).toFixed(1)}s` });
    t += ms;
  }
  return out;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Snapshot of a mock job at time `now`.
 * @param {{id:string, project_id:string, engine:string, options:object, created_at:string, image_count:number, canceled_at?:string}} job
 * @returns {{job:object, logs:{level:string,message:string,ts:string}[]}}
 */
export function materialize(job, now = Date.now()) {
  const plan = planJob({ engine: job.engine, options: job.options, imageCount: job.image_count });
  const created = Date.parse(job.created_at);
  const canceledAt = job.canceled_at ? Date.parse(job.canceled_at) : Infinity;
  const effectiveNow = Math.min(now, canceledAt);
  const elapsed = effectiveNow - created;
  const base = {
    id: job.id,
    project_id: job.project_id,
    engine: job.engine,
    options: job.options,
    created_at: job.created_at,
    started_at: null,
    finished_at: null,
    status: 'queued',
    stage: null,
    progress: 0,
    message: 'Waiting for a worker',
    error: null,
    metrics: null,
    artifacts: [],
  };

  const logs = allLogs(job, plan)
    .filter((l) => l.at <= elapsed)
    .map((l) => ({ level: l.level, message: l.message, ts: iso(created + l.at) }));

  if (elapsed < QUEUE_MS) {
    if (now >= canceledAt) return { job: { ...base, status: 'canceled', message: 'Canceled', finished_at: job.canceled_at }, logs };
    return { job: base, logs };
  }

  const startedAt = created + QUEUE_MS;
  let t = elapsed - QUEUE_MS;
  let doneMs = 0;
  const snap = { ...base, status: 'running', started_at: iso(startedAt) };

  for (const { stage, ms } of plan.stages) {
    const failHere = plan.fail?.stage === stage;
    const stageEnd = failHere ? ms * plan.fail.at : ms;
    if (t < stageEnd || failHere) {
      const frac = Math.min(1, Math.max(0, t / ms));
      snap.stage = stage;
      snap.progress = Math.min(99.5, ((doneMs + Math.min(t, stageEnd)) / plan.total) * 100);
      snap.message = stageMessage(stage, frac, job);
      if (failHere && t >= stageEnd) {
        Object.assign(snap, { status: 'failed', error: plan.fail.error, message: plan.fail.error, finished_at: iso(startedAt + doneMs + stageEnd) });
      } else if (now >= canceledAt) {
        Object.assign(snap, { status: 'canceled', message: 'Canceled by user', finished_at: job.canceled_at });
      }
      snap.progress = Math.round(snap.progress * 10) / 10;
      return { job: snap, logs };
    }
    t -= ms;
    doneMs += ms;
  }

  // succeeded
  const n = job.image_count;
  const faces = Math.round((job.options?.target_faces ?? 100000) * 0.985);
  return {
    job: {
      ...snap,
      status: 'succeeded',
      stage: 'export',
      progress: 100,
      message: 'Done',
      finished_at: iso(startedAt + plan.total),
      metrics: {
        input_images: n,
        registered_images: n > 10 ? n - 1 : n,
        sparse_points: n * 912,
        dense_points: Math.round(2410000 * ({ draft: 0.4, standard: 1, high: 2.3 }[job.options?.quality] ?? 1)),
        faces,
        vertices: Math.round(faces / 2) + 2,
        texture_size: job.options?.texture_size ?? 2048,
        mean_reprojection_error: 0.61,
        duration_s: plan.total / 1000,
      },
    },
    logs,
  };
}
