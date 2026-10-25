// Public surface of the Orca adapter. Consumers import only from here (lint rule
// `local/adapters-via-index`) and receive protocol-neutral readings; nothing
// Orca-specific is exported (#5, criterion 8).
export { DEFAULT_QUOTE_PREFERENCE, readPositions } from './read-positions.js';
export type { ReadPositionsOptions } from './read-positions.js';
export { FixtureMismatchError, recordingPort, replayPort } from './fixture.js';
export type { Fixture } from './fixture.js';
export { createRpcPort } from './rpc.js';
export type { RawAccount, SolanaReadPort } from './port.js';
