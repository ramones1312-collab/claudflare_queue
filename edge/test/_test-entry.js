/**
 * Test entrypoint. Exports the TESTABLE sequencer subclass; the production entrypoints
 * (src/ingress-entry.js, src/consumer-entry.js) export the plain class with no seams.
 */
import producer from '../src/producer.js';
import consumer from '../src/consumer.js';
export { EdgeSequencerTestable } from './_testable-sequencer.js';
export default {
  fetch: (request, env, ctx) => producer.fetch(request, env, ctx),
  queue: (batch, env, ctx) => consumer.queue(batch, env, ctx),
};
