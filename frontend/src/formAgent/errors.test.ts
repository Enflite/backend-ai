import { describe, expect, it } from "vitest"
import { ApiError } from "../api"
import { classifyFormAgentError, formAgentErrorMessage } from "./errors"

describe("classifyFormAgentError", () => {
  it("maps 403 FEATURE_DISABLED to disabled", () => {
    expect(
      classifyFormAgentError(new ApiError(403, "FEATURE_DISABLED", "disabled")),
    ).toBe("disabled")
  })

  it("maps other 403s (missing syteline:forms) to forbidden", () => {
    expect(
      classifyFormAgentError(new ApiError(403, "FORBIDDEN", "no access")),
    ).toBe("forbidden")
  })

  it("maps 400 VALIDATION_ERROR to validation", () => {
    expect(
      classifyFormAgentError(
        new ApiError(400, "VALIDATION_ERROR", "bad input"),
      ),
    ).toBe("validation")
  })

  it("maps everything else to other", () => {
    expect(
      classifyFormAgentError(new ApiError(500, "INTERNAL_ERROR", "boom")),
    ).toBe("other")
    expect(classifyFormAgentError(new Error("network down"))).toBe("other")
    expect(classifyFormAgentError(null)).toBe("other")
  })
})

describe("formAgentErrorMessage", () => {
  it("prefers the ApiError message and falls back for unknown values", () => {
    expect(formAgentErrorMessage(new ApiError(500, "X", "server broke"))).toBe(
      "server broke",
    )
    expect(formAgentErrorMessage(new Error("net"))).toBe("net")
    expect(formAgentErrorMessage(undefined)).toBe("Request failed")
  })
})
