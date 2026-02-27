export interface SprintData {
  t10: number;
  t20: number;
  t30: number;
  t40: number;
  // Joint angles averaged across detected frames (degrees, optional)
  hipAngle?: number;
  kneeAngle?: number;
  ankleAngle?: number;
}

export interface JumpData {
  hip: number;
  knee: number;
  ankle: number;
}

export interface Player {
  id: string;
  name: string;
  age: number;
  position: string;
  avatar: string;
  sprint: SprintData;
  jump: JumpData;
  videosCount: number;
}
