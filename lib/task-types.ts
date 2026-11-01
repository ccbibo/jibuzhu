export type Task = {
  id: string;
  title: string;
  assignee: string | null;
  dueDate: string | null;
  dueText: string | null;
  priority: 'high' | 'normal' | 'low';
  evidence: string;
  lineIndex: number;
  warnings: string[];
};
export type MeetingInput = {
  title: string;
  transcript: string;
  meetingDate: string;
  mode: 'rules' | 'ai';
};
export type Extraction = {
  tasks: Task[];
  summary: string;
  mode: 'rules' | 'ai';
  meetingId: string;
};
export type AppStatus = {
  aiConfigured: boolean;
  notionConfigured: boolean;
  storageReady: boolean;
  model: string;
  targetName: string | null;
};
export type SyncResult = {
  results: { taskId: string; status: 'created' | 'existing' | 'failed' | 'uncertain'; url?: string; message?: string }[];
  retryAfter?: string;
};
