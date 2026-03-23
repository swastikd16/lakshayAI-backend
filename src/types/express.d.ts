declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        email: string | null;
        accessToken: string;
      };
    }
  }
}

export {};
