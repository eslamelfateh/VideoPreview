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
  fadeIn?: number; // seconds
  fadeOut?: number; // seconds
  denoise?: boolean; // background-noise reduction on export
  speed?: number; // 0.25..4, default 1 (audio keeps its pitch)
  videoFadeIn?: number; // seconds of fade from black
  videoFadeOut?: number; // seconds of fade to black
  /** Internal, for single-frame renders: how dark this frame is from a fade (0..1). */
  stillDim?: number;
}

export interface Word {
  text: string;
  start: number;
  end: number;
}

export type TextStyle = 'caption' | 'title';
export type CaptionPreset = 'karaoke' | 'box' | 'pop' | 'minimal' | 'bold';
export type TextPosition = 'bottom' | 'middle' | 'top';

export interface TextItem {
  id: string;
  start: number;
  end: number;
  text: string;
  style: TextStyle;
  /** Present on captions: per-word timing (timeline seconds) drives the karaoke highlight. */
  words?: Word[];
  color?: string; // highlight color for captions, text color for titles
  preset?: CaptionPreset; // captions only; default karaoke
  position?: TextPosition; // default bottom for captions, top for titles
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

/**
 * A point-by-point instruction the user pins on the timeline for the agent.
 * "do" asks for something at that spot; "dont" locks the range: agent edits
 * that would change anything overlapping it are refused by the server.
 */
export interface Marker {
  id: string;
  start: number;
  end: number;
  text: string;
  kind: 'do' | 'dont';
  status: 'open' | 'done';
  reply?: string; // what the agent did about it
}

/** Project-wide audio: music ducking under speech and loudness normalization. */
export interface ProjectAudio {
  duck?: { amount: number; attack: number; release: number }; // amount in dB (negative); speech comes from the transcript
  loudness?: { target: number; gainDb: number; measured: number }; // LUFS
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
  markers: Marker[];
  audio?: ProjectAudio;
  /** Where the crop window sits when the video does not fill the canvas (0 = left/top, 1 = right/bottom), over time. */
  reframe?: ReframeKey[];
}

export interface ReframeKey { t: number; x: number; y: number }

export const COLLECTIONS = ['media', 'clips', 'texts', 'effects', 'transcripts', 'markers'] as const;
/** 'settings' is the project's own fields (canvas, fps, audio), tracked like an entity so undo covers them. */
export type Collection = (typeof COLLECTIONS)[number] | 'settings';

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

/** Derived from media files after import: thumbnails strip and audio peaks for the timeline. */
export interface MediaAssets {
  thumbs?: { file: string; count: number; interval: number; width: number; height: number };
  peaks?: { file: string; perSecond: number };
  /** Small, fast-seeking copy for the preview; exports always use the original. */
  proxy?: { file: string; height: number };
}

/** A question the agent asked the user, answered in the editor. */
export interface Question {
  id: string;
  text: string;
  options?: string[];
  at?: number;
  time: number;
}

export interface ServerState {
  project: Project;
  questions: Question[];
  /** Speech regions on the timeline (from the transcript), for previewing ducking. */
  speech: [number, number][];
  assets: Record<string, MediaAssets>;
  steps: Step[];
  control: Control;
  render: RenderState;
  notes: string[]; // messages from the user not yet delivered to the agent
  agentConnected: boolean;
}
