/** Pipeline stage metadata (docs/ARCHITECTURE.md, section 1). */
export const STAGE_INFO = {
  ingest: { label: 'Ingest', hint: 'Reading photos and extracting video frames' },
  masking: { label: 'Masking', hint: 'Separating the subject from the background' },
  sfm: { label: 'Camera poses', hint: 'Structure from motion: matching features, solving cameras' },
  depth: { label: 'Depth', hint: 'Estimating a depth map for every view' },
  fusion: { label: 'Fusion', hint: 'Fusing depth maps into a dense point cloud' },
  meshing: { label: 'Meshing', hint: 'Building a watertight surface from the points' },
  cleanup: { label: 'Cleanup', hint: 'Removing floaters and decimating to the face budget' },
  texturing: { label: 'Texturing', hint: 'Projecting photo colour onto the surface' },
  export: { label: 'Export', hint: 'Writing GLB, OBJ, PLY and USDZ' },
  generate: { label: 'Generate', hint: 'Generating geometry with a learned model' },
};

export const PHOTOGRAMMETRY_STAGES = ['ingest', 'masking', 'sfm', 'depth', 'fusion', 'meshing', 'cleanup', 'texturing', 'export'];
export const GENERATIVE_STAGES = ['ingest', 'masking', 'generate', 'texturing', 'export'];

export const stageLabel = (stage) => STAGE_INFO[stage]?.label ?? (stage ? stage[0].toUpperCase() + stage.slice(1) : '');

/** The ordered list of stages to show for a job (falls back to inserting unknown stages). */
export function stagesFor(job) {
  const base = job?.engine === 'generative' ? GENERATIVE_STAGES : PHOTOGRAMMETRY_STAGES;
  if (job?.stage && !base.includes(job.stage)) return [...base.slice(0, -1), job.stage, base[base.length - 1]];
  return base;
}

/**
 * Per-stage state for the stepper: 'done' | 'active' | 'pending' | 'failed'.
 * @param {import('../api/client.js').Job|null} job
 */
export function stageStates(job) {
  const list = stagesFor(job);
  const current = job?.stage ? list.indexOf(job.stage) : -1;
  return list.map((stage, i) => {
    let state = 'pending';
    if (job?.status === 'succeeded') state = 'done';
    else if (i < current) state = 'done';
    else if (i === current) {
      if (job.status === 'failed') state = 'failed';
      else if (job.status === 'canceled') state = 'pending';
      else state = 'active';
    }
    return { stage, label: stageLabel(stage), hint: STAGE_INFO[stage]?.hint ?? '', state };
  });
}
