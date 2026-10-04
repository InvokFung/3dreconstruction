import { useEffect, useReducer, useRef } from 'react';
import { api } from '../api/index.js';
import { connectJobEvents } from '../lib/jobStream.js';
import { initialJobState, isTerminal, jobReducer } from '../lib/jobReducer.js';

/**
 * Live state of one job. While the job is queued/running it stays subscribed to the SSE stream
 * (with reconnects). `dispatch({type:'reset', job})` switches to another job.
 *
 * @param {(job:object)=>void} [onEnd] called once when the followed job reaches a terminal state
 */
export function useJobStream(onEnd) {
  const [state, dispatch] = useReducer(jobReducer, initialJobState);
  const onEndRef = useRef(onEnd);
  useEffect(() => {
    onEndRef.current = onEnd;
  }, [onEnd]);

  const jobId = state.job?.id;
  const live = Boolean(state.job) && !isTerminal(state.job);

  useEffect(() => {
    if (!jobId || !live) return undefined;
    return connectJobEvents(api, jobId, {
      onJob: (job) => dispatch({ type: 'job', job }),
      onLog: (log) => dispatch({ type: 'log', log }),
      onEnd: (job) => {
        dispatch({ type: 'end', job });
        onEndRef.current?.(job);
      },
      onStatus: (status) => dispatch({ type: 'connection', status }),
    });
  }, [jobId, live]);

  return [state, dispatch];
}
