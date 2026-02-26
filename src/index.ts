// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  FieldType,
  FieldDescriptor,
  BinarySchemaDescriptor,
  StrandMap,
  StrandStatus,
} from './types';

export {
  FIELD_BYTE_WIDTHS,
  FIELD_FLAG_NULLABLE,
  FIELD_FLAG_SORTED_ASC,
  FIELD_FLAG_SORTED_DESC,
} from './types';

// ─── Constants ────────────────────────────────────────────────────────────────
export {
  STRAND_MAGIC,
  STRAND_VERSION,
  HEADER_SIZE,
  MAX_SCHEMA_BYTES,
  OFFSET_HEADER_CRC,
  CTRL_WRITE_SEQ,
  CTRL_COMMIT_SEQ,
  CTRL_READ_CURSOR,
  CTRL_STATUS,
  CTRL_HEAP_WRITE,
  CTRL_HEAP_COMMIT,
  CTRL_ABORT,
  STATUS_INITIALIZING,
  STATUS_STREAMING,
  STATUS_EOS,
  STATUS_ERROR,
  HEAP_SKIP_MAGIC,
  HEAP_SKIP_SIZE,
  heapStart,
  computeTotalBytes,
} from './constants';

// ─── Schema ───────────────────────────────────────────────────────────────────
export {
  buildSchema,
  encodeSchema,
  decodeSchema,
  schemaFingerprint,
} from './schema';

// ─── Header ───────────────────────────────────────────────────────────────────
export {
  initStrandHeader,
  readStrandHeader,
  computeStrandMap,
  StrandHeaderError,
} from './header';

// ─── View ─────────────────────────────────────────────────────────────────────
export { StrandView, RecordCursor } from './view';

// ─── Writer ───────────────────────────────────────────────────────────────────
export { StrandWriter, StrandCapacityError, StrandAbortError } from './writer';
export type { WritableValue, WritableRecord } from './writer';
