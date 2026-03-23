import { supabaseService } from "../lib/supabase";

export type ExpandedAttempt = {
  attemptId: string;
  sessionId: string;
  questionId: string;
  selectedOption: string | null;
  isCorrect: boolean | null;
  timeSpentSec: number | null;
  createdAt: string;
  subject: string;
  topic: string;
  prompt: string;
  options: Record<string, string>;
  correctOption: string;
};

export async function getSessionIds(userId: string) {
  const { data, error } = await supabaseService
    .from("practice_sessions")
    .select("id")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1000);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => row.id);
}

export async function getExpandedAttempts(userId: string, limit = 1000): Promise<ExpandedAttempt[]> {
  const sessionIds = await getSessionIds(userId);
  if (sessionIds.length === 0) {
    return [];
  }

  const { data: attempts, error: attemptsError } = await supabaseService
    .from("practice_attempts")
    .select("id,session_id,question_id,selected_option,is_correct,time_spent_sec,created_at")
    .in("session_id", sessionIds)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (attemptsError) {
    throw attemptsError;
  }

  const questionIds = [...new Set((attempts ?? []).map((row) => row.question_id))];
  if (questionIds.length === 0) {
    return [];
  }

  const { data: questions, error: questionError } = await supabaseService
    .from("questions")
    .select("id,subject,topic,prompt,options,correct_option")
    .in("id", questionIds);

  if (questionError) {
    throw questionError;
  }

  const questionMap = new Map<string, any>((questions ?? []).map((row) => [row.id, row]));

  return (attempts ?? [])
    .map((row) => {
      const question = questionMap.get(row.question_id);
      if (!question) {
        return null;
      }

      return {
        attemptId: row.id,
        sessionId: row.session_id,
        questionId: row.question_id,
        selectedOption: row.selected_option,
        isCorrect: row.is_correct,
        timeSpentSec: row.time_spent_sec,
        createdAt: row.created_at,
        subject: question.subject,
        topic: question.topic,
        prompt: question.prompt,
        options: (question.options ?? {}) as Record<string, string>,
        correctOption: question.correct_option
      } satisfies ExpandedAttempt;
    })
    .filter((row): row is ExpandedAttempt => Boolean(row));
}

export async function getLatestExamType(userId: string) {
  const { data, error } = await supabaseService
    .from("user_exam_settings")
    .select("exam_type")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.exam_type ?? "JEE";
}

export function getTodayDateIso() {
  return new Date().toISOString().slice(0, 10);
}

export function startOfDay(date = new Date()) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

export function endOfDay(date = new Date()) {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value;
}
