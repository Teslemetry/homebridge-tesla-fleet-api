import { Logging } from "homebridge";
import { Teslemetry } from "tesla-fleet-api";
import { EventEmitter } from "./events";
import { lock } from "./mutex";
import { TeslaPluginConfig, VehicleData } from "./types";
import { wait } from "./wait";

export interface TeslaApiEvents {
  vehicleDataUpdated(data: VehicleData): void;
}

export class TeslaApi extends EventEmitter<TeslaApiEvents> {
  private log: Logging;
  private config: TeslaPluginConfig;
  private teslemetry: Teslemetry;

  // Runtime state.
  private accessToken: string | undefined;

  // Cached state.
  private lastOptions: TeslaJSOptions | null = null; // Vehicle
  private lastOptionsTime = 0;
  private lastVehicleData: VehicleData | null = null; // Vehicle Data
  private lastVehicleDataTime = 0;

  // Keep track of how many commands are being executed at once so we don't
  // notify event listeners until the last one is completed.
  private commandsRunning = 0;

  constructor(log: Logging, config: TeslaPluginConfig) {
    super();
    this.log = log;
    this.config = config;
    this.teslemetry = new Teslemetry(config.accessToken);
  }

  getVehicle = async () => this.teslemetry.vehicle.vehicle(this.config.vin);

  wakeUp = async (options: TeslaJSOptions) => {
    // Is the car online already?
    if (options.isOnline) {
      this.log("Vehicle is online.");
      return;
    }

    this.log("Sending wakeup command…");

    // Send the command.
    await api("wakeUp", options);

    // Wait up to 30 seconds for the car to wake up.
    const start = Date.now();
    let waitTime = 2000;
    const waitMinutes = this.config.waitMinutes || 1;

    while (Date.now() - start < waitMinutes * 60 * 1000) {
      // Poll Tesla for the latest on this vehicle.
      const { state } = await this.getVehicle();

      if (state === "online") {
        // Success!
        this.log("Vehicle is now online.");
        return;
      }

      this.log("Waiting for vehicle to wake up...");
      await wait(waitTime);

      // Use exponential backoff with a max wait of 10 seconds.
      waitTime = Math.min(waitTime * 2, 10_000);
    }

    throw new Error(`Vehicle did not wake up within ${waitMinutes} minutes.`);
  };

  public async getVehicleData({
    ignoreCache,
  }: { ignoreCache?: boolean } = {}): Promise<VehicleData | null> {
    // Use a mutex to prevent multiple calls happening in parallel.
    const unlock = await lock("getVehicleData", 20_000);

    if (!unlock) {
      this.log("Failed to acquire lock for getVehicleData");
      return null;
    }

    try {
      // If the cached value is less than 2500ms old, return it.
      const cacheAge = Date.now() - this.lastVehicleDataTime;

      if (cacheAge < 2500 && !ignoreCache) {
        // this.log("Using just-cached vehicle data.");
        return this.lastVehicleData;
      }

      const options = await this.getOptions({ ignoreCache });

      if (!options.isOnline) {
        // If we're ignoring cache, we'll have to return null here.
        if (ignoreCache) {
          return null;
        }

        this.log(
          `Vehicle is not online; using ${
            this.lastVehicleData ? "last known" : "default"
          } state.`,
        );

        // Set the last update time to now to prevent spamming the logs with the
        // directly-above message. If the vehicle becomes online, we'll get
        // called with ignoreCache=true anyway.
        this.lastVehicleDataTime = Date.now();

        return this.lastVehicleData;
      }

      // Get the latest data from Tesla.
      this.log(
        `Getting latest vehicle data from Tesla${
          ignoreCache ? " (forced update)" : ""
        }…`,
      );

      let data: VehicleData;

      try {
        data = await this.api("vehicleData", options);
      } catch (error: any) {
        // Make sure these don't happen too often.
        this.lastVehicleData = null;
        this.lastVehicleDataTime = Date.now();
        return null;
      }

      this.log("Vehicle data updated.");

      // Cache the state.
      this.lastVehicleData = data;
      this.lastVehicleDataTime = Date.now();

      // Notify any listeners unless there is more than one command running
      // right now.
      if (this.commandsRunning <= 1) {
        this.emit("vehicleDataUpdated", data);
      }

      return data;
    } finally {
      unlock();
    }
  }

  /**
   * Wakes up the vehicle,
   */
  public async wakeAndCommand(
    func: (options: TeslaJSOptions) => Promise<void>,
  ) {
    this.commandsRunning++;
    let options: TeslaJSOptions;

    try {
      // We do want to wait for this to finish because it can help surface token
      // errors to the end-user attempting to execute the command.
      options = await this.getOptions({ ignoreCache: true });
    } catch (error: any) {
      this.commandsRunning--;
      throw error;
    }

    const background = async () => {
      try {
        if (!options.isOnline) {
          await this.wakeUp(options);
        }

        await func(options);

        // Refresh vehicle data since we're already connected and we just sent
        // a command.
        await this.getVehicleData({ ignoreCache: true });
      } catch (error: any) {
        this.log("Error while executing command:", error.message);
      } finally {
        this.commandsRunning--;
      }
    };

    const promise = background();

    // Only wait on the promise for a maximum of 5 seconds. If it takes much
    // longer, it ends up being a bad experience.
    await Promise.race([promise, wait(5_000)]);
  }

  public async api(
    name: string,
    options: TeslaJSOptions,
    ...args: any[]
  ): Promise<any> {
    try {
      return await teslajs[name + "Async"](options, ...args);
    } catch (error: any) {
      if (error.message === "Error response: 408") {
        console.log(
          `Tesla timed out communicating with the vehicle while executing "${name}".`,
        );
      } else {
        console.log(
          `TeslaJS error while executing "${name}":`,
          error.message,
          error,
        );
      }

      throw error;
    }
  }
}

interface TeslaJSOptions {
  authToken: string;
  vehicleID: string;
  isOnline: boolean;
}

// teslajs.setLogLevel(tesla.API_LOG_ALL);

// Wrapper for TeslaJS functions that don't throw Error objects!
export default async function api(name: string, ...args: any[]): Promise<any> {
  try {
    return await teslajs[name + "Async"](...args);
  } catch (errorOrString) {
    let error;

    if (typeof errorOrString === "string") {
      error = new Error(errorOrString);
    } else {
      error = errorOrString;
    }

    if (error.message === "Error response: 408") {
      console.log("Tesla timed out communicating with the vehicle.");
    } else {
      console.log("TeslaJS error:", errorOrString);
    }

    throw error;
  }
}
