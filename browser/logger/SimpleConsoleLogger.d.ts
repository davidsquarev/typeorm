import { AbstractLogger } from "./AbstractLogger";
import { LogLevel, LogMessage } from "./Logger";
import { QueryRunner } from "../query-runner/QueryRunner";
/**
 * Performs logging of the events in TypeORM.
 * This version of logger uses console to log events and does not use syntax highlighting.
 */
export declare class SimpleConsoleLogger extends AbstractLogger {
    /**
     * Write log to specific output.
     */
    protected writeLog(level: LogLevel, logMessage: LogMessage | LogMessage[], queryRunner?: QueryRunner): void;
}
