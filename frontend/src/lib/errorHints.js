/**
 * Turns a failed job into actionable advice. The pipeline reports a human readable `error`; we match
 * on its wording and on the stage it failed in.
 * @returns {{title:string, hints:string[], actions:('photos'|'settings'|'retry')[]}}
 */
export function errorHints(job) {
  const text = `${job?.error ?? ''} ${job?.message ?? ''}`.toLowerCase();
  const stage = job?.stage;
  const hints = [];
  const actions = new Set();

  if (/align|regist|match|feature|overlap|too few|pose|sfm/.test(text) || stage === 'sfm') {
    hints.push(
      'Add more photos so neighbouring shots overlap by 60–80%. Walk around the object in small steps.',
      'Avoid blurry or dark photos; keep the subject in focus and evenly lit.',
      'Plain, shiny or transparent surfaces have no features to match. Place the object on a textured surface (a newspaper works).',
    );
    actions.add('photos');
  }
  if (/mask|segment|background|subject/.test(text) || stage === 'masking') {
    hints.push('Switch Mode to “Scene” to skip background removal, or shoot against a plain, contrasting background.');
    actions.add('settings');
  }
  if (/memory|oom|out of memory|cuda|gpu|killed/.test(text)) {
    hints.push('The server ran out of memory. Try Draft or Standard quality, a 2048 texture, or a lower face target.');
    actions.add('settings');
  }
  if (/timeout|timed out|time limit/.test(text)) {
    hints.push('The job hit the time limit. Use Draft quality or fewer, sharper photos.');
    actions.add('settings');
  }
  if (/video|frame|decode|codec|ffmpeg/.test(text)) {
    hints.push('The video could not be read. Re-export it as MP4 (H.264), or upload still photos instead.');
    actions.add('photos');
  }
  if (/no (input|images|photos)|empty|at least/.test(text)) {
    hints.push('Upload at least 20 photos of the object from all sides.');
    actions.add('photos');
  }
  if (/engine|not available|unavailable/.test(text)) {
    hints.push('This engine isn’t available on the server right now. Choose another engine.');
    actions.add('settings');
  }
  if (!hints.length) {
    hints.push('Retry the job; transient failures happen.', 'If it fails again, open the log for details, then try Draft quality or a different set of photos.');
  }
  actions.add('retry');
  return { title: 'Reconstruction failed', hints, actions: [...actions] };
}
