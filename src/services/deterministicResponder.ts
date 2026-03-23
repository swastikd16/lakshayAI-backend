export type DeterministicReply = {
  contentText: string;
  structuredResponse: {
    title: string;
    summary: string;
    steps: Array<{ title: string; body: string }>;
    equations: string[];
  };
  confidence: number;
  sources: string[];
};

export function buildAssistantReply(questionText: string): DeterministicReply {
  const q = questionText.toLowerCase();
  const isElectro = q.includes("gauss") || q.includes("electric") || q.includes("charge");
  const isWorkEnergy = q.includes("work") || q.includes("energy") || q.includes("spring");

  if (isElectro) {
    return {
      contentText:
        "Apply Gauss's law, express enclosed charge as a radius function, then use the ratio condition to solve the exponent.",
      structuredResponse: {
        title: "Solving with Gauss's law",
        summary:
          "The quickest route is to convert field ratio into a power relation by deriving E(r) from enclosed charge.",
        steps: [
          {
            title: "Use Gauss's law",
            body: "E(4pi r^2) = q_enclosed/epsilon_0 for spherical symmetry."
          },
          {
            title: "Integrate density",
            body: "For rho proportional to (r/R)^n, enclosed charge scales with r^(n+3)."
          },
          {
            title: "Apply ratio",
            body: "E(r) scales as r^(n+1), then solve with E(R/2)/E(R)."
          }
        ],
        equations: [
          "E(r) = q_enclosed / (4 pi epsilon_0 r^2)",
          "q_enclosed(r) proportional to integral_0^r r'^(n+2) dr'",
          "E(R/2)/E(R) = (1/2)^(n+1)"
        ]
      },
      confidence: 0.984,
      sources: ["NCERT Physics", "Standard electrostatics derivation"]
    };
  }

  if (isWorkEnergy) {
    return {
      contentText:
        "Write work by gravity, friction, and spring, and equate total work to kinetic-energy change.",
      structuredResponse: {
        title: "Work-energy setup",
        summary:
          "Track signs carefully and solve in one equation chain from W_net = Delta K.",
        steps: [
          {
            title: "Identify forces",
            body: "Gravity, kinetic friction, and spring force along direction of motion."
          },
          {
            title: "Write balance",
            body: "W_gravity + W_friction + W_spring = Delta K."
          },
          {
            title: "Substitute and solve",
            body: "Replace each work term and isolate unknown variable."
          }
        ],
        equations: [
          "W_net = Delta K",
          "W_gravity + W_friction + W_spring = 1/2 m v_f^2 - 1/2 m v_i^2"
        ]
      },
      confidence: 0.978,
      sources: ["HC Verma", "NCERT Physics"]
    };
  }

  return {
    contentText:
      "Break the question into knowns, target variable, governing formula, then verify with constraints.",
    structuredResponse: {
      title: "General solution strategy",
      summary: "This response uses a deterministic reasoning template based on topic keywords.",
      steps: [
        {
          title: "Extract known values",
          body: "List all given values and constraints from the prompt."
        },
        {
          title: "Apply governing relation",
          body: "Choose the most direct formula and substitute known terms."
        },
        {
          title: "Validate",
          body: "Check unit consistency and condition match from question text."
        }
      ],
      equations: ["governing_equation(knowns) = unknown", "validate(unknown, constraints) = true"]
    },
    confidence: 0.962,
    sources: ["Lakshay AI deterministic template"]
  };
}
