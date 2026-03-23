export type AuthUserDto = {
  id: string;
  email: string | null;
  fullName: string;
  targetExam: string | null;
};

export type AuthSessionDto = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  user: AuthUserDto;
};

export type OnboardingPayloadDto = {
  examType: "JEE" | "NEET" | "UPSC";
  targetDate: string;
  dailyHoursTarget: number;
  confidenceBySubject: Record<string, number>;
};
