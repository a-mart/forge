import { describe, expect, it, vi } from "vitest";
import {
  SwarmManagerFacade,
  type SwarmManagerFacadeServices,
} from "../swarm-manager-facade.js";

describe("SwarmManagerSessionFacade", () => {
  it("closes the Codex Plugin scope before stopping a worker", async () => {
    const calls: string[] = [];
    const services = createServices();
    services.codexPlugin.markWorkerStoppedAndCloseScope = vi.fn(() => calls.push("codex"));
    services.agents.stopWorker = vi.fn(async () => {
      calls.push("lifecycle");
    });
    const facade = new TestFacade(services);

    await facade.stopWorker("worker");

    expect(calls).toEqual(["codex", "lifecycle"]);
  });
});

class TestFacade extends SwarmManagerFacade {
  constructor(private readonly facadeServices: SwarmManagerFacadeServices) {
    super();
  }

  protected getFacadeServices(): SwarmManagerFacadeServices {
    return this.facadeServices;
  }
}

function createServices(): SwarmManagerFacadeServices {
  return {
    agents: {
      stopWorker: vi.fn(async () => undefined),
    },
    codexPlugin: {
      markWorkerStoppedAndCloseScope: vi.fn(),
    },
  } as unknown as SwarmManagerFacadeServices;
}
