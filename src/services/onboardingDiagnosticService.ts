const allowedExamTypes = ["JEE", "NEET", "UPSC"] as const;

export type SupportedExamType = (typeof allowedExamTypes)[number];
export type DiagnosticSubject = "physics" | "chemistry" | "mathematics";

type DiagnosticQuestionRecord = {
  id: string;
  subject: DiagnosticSubject;
  topic: string;
  prompt: string;
  options: string[];
  correctOption: string;
};

export type DiagnosticQuestionDto = Omit<DiagnosticQuestionRecord, "correctOption">;

export type DiagnosticAnswer = {
  questionId: string;
  selectedOption: string;
};

export type DiagnosticWeakTopic = {
  subject: DiagnosticSubject;
  topic: string;
  accuracy: number;
  correct: boolean;
  riskLevel: "critical" | "high" | "medium";
  retentionEstimate: number;
};

const questionBank: DiagnosticQuestionRecord[] = [
  {
    id: "physics-mechanics-01",
    subject: "physics",
    topic: "Mechanics",
    prompt: "A body is projected vertically upward with speed u. Ignoring air resistance, what is its speed when it returns to the point of projection?",
    options: ["u/2", "u", "2u", "0"],
    correctOption: "u"
  },
  {
    id: "physics-electrostatics-01",
    subject: "physics",
    topic: "Electrostatics",
    prompt: "The SI unit of electric field is:",
    options: ["N/C", "C/N", "J/C", "V/A"],
    correctOption: "N/C"
  },
  {
    id: "physics-current-electricity-01",
    subject: "physics",
    topic: "Current Electricity",
    prompt: "Two resistors 3 ohm and 6 ohm are connected in parallel. Their equivalent resistance is:",
    options: ["9 ohm", "2 ohm", "4 ohm", "3 ohm"],
    correctOption: "2 ohm"
  },
  {
    id: "physics-optics-01",
    subject: "physics",
    topic: "Optics",
    prompt: "For a concave mirror, the focus lies:",
    options: ["Behind the mirror", "At infinity", "In front of the mirror", "At the pole"],
    correctOption: "In front of the mirror"
  },
  {
    id: "physics-modern-physics-01",
    subject: "physics",
    topic: "Modern Physics",
    prompt: "The phenomenon that supports the particle nature of light is:",
    options: ["Interference", "Diffraction", "Photoelectric effect", "Polarization"],
    correctOption: "Photoelectric effect"
  },
  {
    id: "chemistry-chemical-bonding-01",
    subject: "chemistry",
    topic: "Chemical Bonding",
    prompt: "The shape of a methane molecule is:",
    options: ["Trigonal planar", "Tetrahedral", "Bent", "Linear"],
    correctOption: "Tetrahedral"
  },
  {
    id: "chemistry-thermodynamics-01",
    subject: "chemistry",
    topic: "Thermodynamics",
    prompt: "The enthalpy change at constant pressure is equal to:",
    options: ["Heat absorbed", "Work done", "Internal energy", "Entropy change"],
    correctOption: "Heat absorbed"
  },
  {
    id: "chemistry-equilibrium-01",
    subject: "chemistry",
    topic: "Equilibrium",
    prompt: "For a reversible reaction at equilibrium, the forward reaction rate is:",
    options: ["Zero", "Greater than reverse rate", "Less than reverse rate", "Equal to reverse rate"],
    correctOption: "Equal to reverse rate"
  },
  {
    id: "chemistry-electrochemistry-01",
    subject: "chemistry",
    topic: "Electrochemistry",
    prompt: "Oxidation occurs at which electrode in an electrochemical cell?",
    options: ["Cathode", "Anode", "Salt bridge", "Electrolyte"],
    correctOption: "Anode"
  },
  {
    id: "chemistry-organic-goc-01",
    subject: "chemistry",
    topic: "Organic GOC",
    prompt: "An electron-withdrawing group generally stabilizes which species the most?",
    options: ["Carbocation less", "Carbanion more", "Free radical only", "No species"],
    correctOption: "Carbanion more"
  },
  {
    id: "maths-calculus-01",
    subject: "mathematics",
    topic: "Calculus",
    prompt: "The derivative of x^2 with respect to x is:",
    options: ["x", "2x", "x^2", "2"],
    correctOption: "2x"
  },
  {
    id: "maths-algebra-01",
    subject: "mathematics",
    topic: "Algebra",
    prompt: "If a + b = 5 and ab = 6, then a and b are roots of:",
    options: ["x^2 - 5x + 6 = 0", "x^2 + 5x + 6 = 0", "x^2 - 6x + 5 = 0", "x^2 + 6x + 5 = 0"],
    correctOption: "x^2 - 5x + 6 = 0"
  },
  {
    id: "maths-coordinate-geometry-01",
    subject: "mathematics",
    topic: "Coordinate Geometry",
    prompt: "The distance between (0, 0) and (3, 4) is:",
    options: ["4", "5", "6", "7"],
    correctOption: "5"
  },
  {
    id: "maths-trigonometry-01",
    subject: "mathematics",
    topic: "Trigonometry",
    prompt: "sin^2 theta + cos^2 theta is equal to:",
    options: ["0", "1", "tan theta", "sec theta"],
    correctOption: "1"
  },
  {
    id: "maths-probability-01",
    subject: "mathematics",
    topic: "Probability",
    prompt: "For any event A, the value of P(A) lies between:",
    options: ["-1 and 1", "0 and 1", "0 and 100", "1 and infinity"],
    correctOption: "0 and 1"
  }
];

const questionMap = new Map(questionBank.map((question) => [question.id, question]));

export function isSupportedExamType(examType: unknown): examType is SupportedExamType {
  return typeof examType === "string" && allowedExamTypes.includes(examType as SupportedExamType);
}

export function getDiagnosticQuestionBank(examType: unknown): {
  examType: SupportedExamType;
  questions: DiagnosticQuestionDto[];
} {
  const normalizedExamType = isSupportedExamType(examType) ? examType : "JEE";

  return {
    examType: normalizedExamType,
    questions: questionBank.map(({ correctOption: _correctOption, ...question }) => question)
  };
}

export function evaluateDiagnosticAnswers(answers: unknown): {
  answersEvaluated: number;
  subjectAccuracy: Record<DiagnosticSubject, number>;
  weakTopics: DiagnosticWeakTopic[];
} {
  const safeAnswers = Array.isArray(answers) ? answers : [];
  const latestSelections = new Map<string, string>();

  safeAnswers.forEach((entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }

    const { questionId, selectedOption } = entry as Partial<DiagnosticAnswer>;
    if (typeof questionId !== "string" || typeof selectedOption !== "string") {
      return;
    }

    latestSelections.set(questionId, selectedOption.trim());
  });

  const subjectTotals: Record<DiagnosticSubject, { total: number; correct: number }> = {
    physics: { total: 0, correct: 0 },
    chemistry: { total: 0, correct: 0 },
    mathematics: { total: 0, correct: 0 }
  };

  const weakTopics: DiagnosticWeakTopic[] = [];

  questionBank.forEach((question) => {
    subjectTotals[question.subject].total += 1;
    const selected = latestSelections.get(question.id);
    const isCorrect = selected === question.correctOption;

    if (isCorrect) {
      subjectTotals[question.subject].correct += 1;
      return;
    }

    const accuracy = selected ? 0 : 0;
    weakTopics.push({
      subject: question.subject,
      topic: question.topic,
      accuracy,
      correct: false,
      riskLevel: selected ? "high" : "critical",
      retentionEstimate: selected ? 42 : 28
    });
  });

  const subjectAccuracy = {
    physics: calculateAccuracy(subjectTotals.physics.correct, subjectTotals.physics.total),
    chemistry: calculateAccuracy(subjectTotals.chemistry.correct, subjectTotals.chemistry.total),
    mathematics: calculateAccuracy(subjectTotals.mathematics.correct, subjectTotals.mathematics.total)
  };

  return {
    answersEvaluated: latestSelections.size,
    subjectAccuracy,
    weakTopics
  };
}

function calculateAccuracy(correct: number, total: number) {
  if (!total) {
    return 0;
  }

  return Math.round((correct / total) * 100);
}

export function hasDiagnosticQuestion(questionId: string) {
  return questionMap.has(questionId);
}
