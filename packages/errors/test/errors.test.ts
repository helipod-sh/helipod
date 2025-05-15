import { describe, it, expect } from "vitest";
import {
  StackbaseError,
  UserError,
  SystemError,
  TransientError,
  ConflictError,
  OccConflictError,
  ArgumentValidationError,
  DocumentNotFoundError,
  ForbiddenOperationError,
  RateLimitError,
  TimeoutError,
  InternalError,
  isStackbaseError,
  isRetryableError,
  getHttpStatus,
  toStackbaseError,
} from "../src/index";

describe("StackbaseError hierarchy", () => {
  it("carries code/httpStatus/retryable and the concrete class name", () => {
    const e = new ArgumentValidationError("bad arg");
    expect(e).toBeInstanceOf(StackbaseError);
    expect(e).toBeInstanceOf(UserError);
    expect(e.name).toBe("ArgumentValidationError");
    expect(e.code).toBe("ARGUMENT_VALIDATION");
    expect(e.httpStatus).toBe(400);
    expect(e.retryable).toBe(false);
    expect(e.message).toBe("bad arg");
  });

  it("lets subclasses override httpStatus", () => {
    expect(new DocumentNotFoundError("x").httpStatus).toBe(404);
    expect(new ForbiddenOperationError("x").httpStatus).toBe(403);
    expect(new RateLimitError("x").httpStatus).toBe(429);
    expect(new TimeoutError("x").httpStatus).toBe(504);
  });

  it("marks conflict and transient errors retryable", () => {
    expect(new OccConflictError("conflict")).toBeInstanceOf(ConflictError);
    expect(isRetryableError(new OccConflictError("conflict"))).toBe(true);
    expect(isRetryableError(new RateLimitError("slow"))).toBe(true);
    expect(isRetryableError(new ArgumentValidationError("no"))).toBe(false);
  });

  it("serializes losslessly via toJSON", () => {
    const e = new ArgumentValidationError("bad", { data: { field: "title" } });
    expect(e.toJSON()).toEqual({
      name: "ArgumentValidationError",
      code: "ARGUMENT_VALIDATION",
      message: "bad",
      httpStatus: 400,
      retryable: false,
      data: { field: "title" },
    });
  });

  it("preserves the cause chain", () => {
    const root = new Error("io failed");
    const e = new InternalError("wrapped", { cause: root });
    expect(e.cause).toBe(root);
  });
});

describe("helpers", () => {
  it("isStackbaseError discriminates", () => {
    expect(isStackbaseError(new InternalError("x"))).toBe(true);
    expect(isStackbaseError(new Error("plain"))).toBe(false);
    expect(isStackbaseError("nope")).toBe(false);
  });

  it("getHttpStatus defaults non-Stackbase errors to 500", () => {
    expect(getHttpStatus(new Error("plain"))).toBe(500);
    expect(getHttpStatus("oops")).toBe(500);
    expect(getHttpStatus(new TimeoutError("t"))).toBe(504);
  });

  it("toStackbaseError normalizes any thrown value", () => {
    const fromStackbase = new ArgumentValidationError("a");
    expect(toStackbaseError(fromStackbase)).toBe(fromStackbase);

    const fromError = toStackbaseError(new Error("boom"));
    expect(fromError).toBeInstanceOf(InternalError);
    expect(fromError.message).toBe("boom");

    const fromString = toStackbaseError("weird");
    expect(fromString).toBeInstanceOf(InternalError);
    expect(fromString.message).toBe("weird");

    const fromObject = toStackbaseError({ nope: 1 });
    expect(fromObject).toBeInstanceOf(InternalError);
    expect(fromObject.data).toEqual({ nope: 1 });
  });
});

describe("TransientError family", () => {
  it("all transient errors are retryable 5xx/429", () => {
    for (const e of [new TimeoutError("t"), new RateLimitError("r")]) {
      expect(e).toBeInstanceOf(TransientError);
      expect(e.retryable).toBe(true);
    }
  });
});
