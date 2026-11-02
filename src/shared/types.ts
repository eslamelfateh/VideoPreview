// The project is a plain JSON document. Agents change it through MCP tools,
// the browser renders it live, and ffmpeg renders it to a file on export.

export type MediaKind = 'video' | 'audio' | 'image';

export interface Media {
  id: string;
  name: string;
  file: string; // file name inside the media directory
  kind: MediaKind;
  duration: number; // seconds
  width?: number;
  height?: number;
  hasAudio: boolean;
}

export type Track = 'video' | 'audio';

export interface Clip {
  id: string;
  track: Track;
  mediaId: string;
  start: number; // position on the timeline, seconds
  in: number; // source in-point, seconds
  out: number; // source out-point, seconds
  volume: number; // 0..2
}

export interface Word {
  text: string;
  start: number;
  end: number;
}

export type TextStyle = 'caption' | 'title';

export interface TextItem {
  id: string;
  start: number;
  end: number;
  text: string;
  style: TextStyle;
  /** Present on captions: per-word timing (timeline seconds) drives the karaoke highlight. */
  words?: Word[];
  color?: string; // highlight color for captions, text color for titles
}

export interface ZoomEffect {
  id: string;
  kind: 'zoom';
  start: number;
  end: number;
  scale: number;
  ease: number; // seconds to ramp in and out
  anchorX: number; // 0..1
  anchorY: number; // 0..1
}

export type Effect = ZoomEffect;

export interface Transcript {
  mediaId: string;
  language?: string;
  words: Word[]; // source seconds
}

export interface Project {
  name: string;
  width: number;
  height: number;
  fps: number;
  media: Media[];
  clips: Clip[];
  texts: TextItem[];
  effects: Effect[];
  transcripts: Transcript[];
}

export const COLLECTIONS = ['media', 'clips', 'texts', 'effects', 'transcripts'] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** One entity that a step added, removed or changed. */
export interface Change {
  coll: Collection;
  id: string;
  before?: any;
  after?: any;
}

export type StepStatus = 'running' | 'review' | 'done' | 'rejected';

export interface Step {
  id: string;
  n: number;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: StepStatus;
  undone: boolean;
  changes: Change[];
  /** Where on the timeline this step happened, for "jump to". */
  at?: number;
  feedback?: string;
  by: 'agent' | 'user';
  time: number;
}

export type Mode = 'live' | 'step';

export interface Control {
  mode: Mode;
  paused: boolean;
}

export interface RenderState {
  status: 'idle' | 'rendering' | 'done' | 'error';
  progress: number;
  file?: string;
  error?: string;
}

export interface ServerState {
  project: Project;
  steps: Step[];
  control: Control;
  render: RenderState;
  notes: string[]; // messages from the user not yet delivered to the agent
  agentConnected: boolean;
}
