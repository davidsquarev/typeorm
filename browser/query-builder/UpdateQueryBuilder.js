import { QueryBuilder } from "./QueryBuilder";
import { UpdateResult } from "./result/UpdateResult";
import { ReturningStatementNotSupportedError } from "../error/ReturningStatementNotSupportedError";
import { ReturningResultsEntityUpdator } from "./ReturningResultsEntityUpdator";
import { LimitOnUpdateNotSupportedError } from "../error/LimitOnUpdateNotSupportedError";
import { UpdateValuesMissingError } from "../error/UpdateValuesMissingError";
import { TypeORMError } from "../error";
import { EntityPropertyNotFoundError } from "../error/EntityPropertyNotFoundError";
import { DriverUtils } from "../driver/DriverUtils";
/**
 * Allows to build complex sql queries in a fashion way and execute those queries.
 */
export class UpdateQueryBuilder extends QueryBuilder {
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(connectionOrQueryBuilder, queryRunner) {
        super(connectionOrQueryBuilder, queryRunner);
        this["@instanceof"] = Symbol.for("UpdateQueryBuilder");
        this.expressionMap.aliasNamePrefixingEnabled = false;
    }
    // -------------------------------------------------------------------------
    // Public Implemented Methods
    // -------------------------------------------------------------------------
    /**
     * Gets generated SQL query without parameters being replaced.
     */
    getQuery() {
        let sql = this.createComment();
        sql += this.createCteExpression();
        sql += this.createUpdateExpression();
        sql += this.createOrderByExpression();
        sql += this.createLimitExpression();
        return sql.trim();
    }
    /**
     * Executes sql generated by query builder and returns raw database results.
     */
    async execute() {
        const queryRunner = this.obtainQueryRunner();
        let transactionStartedByUs = false;
        try {
            // start transaction if it was enabled
            if (this.expressionMap.useTransaction === true &&
                queryRunner.isTransactionActive === false) {
                await queryRunner.startTransaction();
                transactionStartedByUs = true;
            }
            // call before updation methods in listeners and subscribers
            if (this.expressionMap.callListeners === true &&
                this.expressionMap.mainAlias.hasMetadata) {
                await queryRunner.broadcaster.broadcast("BeforeUpdate", this.expressionMap.mainAlias.metadata, this.expressionMap.valuesSet);
            }
            let declareSql = null;
            let selectOutputSql = null;
            // if update entity mode is enabled we may need extra columns for the returning statement
            const returningResultsEntityUpdator = new ReturningResultsEntityUpdator(queryRunner, this.expressionMap);
            const returningColumns = [];
            if (Array.isArray(this.expressionMap.returning) &&
                this.expressionMap.mainAlias.hasMetadata) {
                for (const columnPath of this.expressionMap.returning) {
                    returningColumns.push(...this.expressionMap.mainAlias.metadata.findColumnsWithPropertyPath(columnPath));
                }
            }
            if (this.expressionMap.updateEntity === true &&
                this.expressionMap.mainAlias.hasMetadata &&
                this.expressionMap.whereEntities.length > 0) {
                this.expressionMap.extraReturningColumns =
                    returningResultsEntityUpdator.getUpdationReturningColumns();
                returningColumns.push(...this.expressionMap.extraReturningColumns.filter((c) => !returningColumns.includes(c)));
            }
            if (returningColumns.length > 0 &&
                this.connection.driver.options.type === "mssql") {
                declareSql = this.connection.driver.buildTableVariableDeclaration("@OutputTable", returningColumns);
                selectOutputSql = `SELECT * FROM @OutputTable`;
            }
            // execute update query
            const [updateSql, parameters] = this.getQueryAndParameters();
            const statements = [declareSql, updateSql, selectOutputSql];
            const queryResult = await queryRunner.query(statements.filter((sql) => sql != null).join(";\n\n"), parameters, true);
            const updateResult = UpdateResult.from(queryResult);
            // if we are updating entities and entity updation is enabled we must update some of entity columns (like version, update date, etc.)
            if (this.expressionMap.updateEntity === true &&
                this.expressionMap.mainAlias.hasMetadata &&
                this.expressionMap.whereEntities.length > 0) {
                await returningResultsEntityUpdator.update(updateResult, this.expressionMap.whereEntities);
            }
            // call after updation methods in listeners and subscribers
            if (this.expressionMap.callListeners === true &&
                this.expressionMap.mainAlias.hasMetadata) {
                await queryRunner.broadcaster.broadcast("AfterUpdate", this.expressionMap.mainAlias.metadata, this.expressionMap.valuesSet);
            }
            // close transaction if we started it
            if (transactionStartedByUs)
                await queryRunner.commitTransaction();
            return updateResult;
        }
        catch (error) {
            // rollback transaction if we started it
            if (transactionStartedByUs) {
                try {
                    await queryRunner.rollbackTransaction();
                }
                catch (rollbackError) { }
            }
            throw error;
        }
        finally {
            if (queryRunner !== this.queryRunner) {
                // means we created our own query runner
                await queryRunner.release();
            }
        }
    }
    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------
    /**
     * Values needs to be updated.
     */
    set(values) {
        this.expressionMap.valuesSet = values;
        return this;
    }
    /**
     * Sets WHERE condition in the query builder.
     * If you had previously WHERE expression defined,
     * calling this function will override previously set WHERE conditions.
     * Additionally you can add parameters used in where expression.
     */
    where(where, parameters) {
        this.expressionMap.wheres = []; // don't move this block below since computeWhereParameter can add where expressions
        const condition = this.getWhereCondition(where);
        if (condition)
            this.expressionMap.wheres = [
                { type: "simple", condition: condition },
            ];
        if (parameters)
            this.setParameters(parameters);
        return this;
    }
    /**
     * Adds new AND WHERE condition in the query builder.
     * Additionally you can add parameters used in where expression.
     */
    andWhere(where, parameters) {
        this.expressionMap.wheres.push({
            type: "and",
            condition: this.getWhereCondition(where),
        });
        if (parameters)
            this.setParameters(parameters);
        return this;
    }
    /**
     * Adds new OR WHERE condition in the query builder.
     * Additionally you can add parameters used in where expression.
     */
    orWhere(where, parameters) {
        this.expressionMap.wheres.push({
            type: "or",
            condition: this.getWhereCondition(where),
        });
        if (parameters)
            this.setParameters(parameters);
        return this;
    }
    /**
     * Sets WHERE condition in the query builder with a condition for the given ids.
     * If you had previously WHERE expression defined,
     * calling this function will override previously set WHERE conditions.
     */
    whereInIds(ids) {
        return this.where(this.getWhereInIdsCondition(ids));
    }
    /**
     * Adds new AND WHERE with conditions for the given ids.
     */
    andWhereInIds(ids) {
        return this.andWhere(this.getWhereInIdsCondition(ids));
    }
    /**
     * Adds new OR WHERE with conditions for the given ids.
     */
    orWhereInIds(ids) {
        return this.orWhere(this.getWhereInIdsCondition(ids));
    }
    /**
     * Optional returning/output clause.
     */
    output(output) {
        return this.returning(output);
    }
    /**
     * Optional returning/output clause.
     */
    returning(returning) {
        // not all databases support returning/output cause
        if (!this.connection.driver.isReturningSqlSupported("update")) {
            throw new ReturningStatementNotSupportedError();
        }
        this.expressionMap.returning = returning;
        return this;
    }
    /**
     * Sets ORDER BY condition in the query builder.
     * If you had previously ORDER BY expression defined,
     * calling this function will override previously set ORDER BY conditions.
     */
    orderBy(sort, order = "ASC", nulls) {
        if (sort) {
            if (typeof sort === "object") {
                this.expressionMap.orderBys = sort;
            }
            else {
                if (nulls) {
                    this.expressionMap.orderBys = {
                        [sort]: { order, nulls },
                    };
                }
                else {
                    this.expressionMap.orderBys = { [sort]: order };
                }
            }
        }
        else {
            this.expressionMap.orderBys = {};
        }
        return this;
    }
    /**
     * Adds ORDER BY condition in the query builder.
     */
    addOrderBy(sort, order = "ASC", nulls) {
        if (nulls) {
            this.expressionMap.orderBys[sort] = { order, nulls };
        }
        else {
            this.expressionMap.orderBys[sort] = order;
        }
        return this;
    }
    /**
     * Sets LIMIT - maximum number of rows to be selected.
     */
    limit(limit) {
        this.expressionMap.limit = limit;
        return this;
    }
    /**
     * Indicates if entity must be updated after update operation.
     * This may produce extra query or use RETURNING / OUTPUT statement (depend on database).
     * Enabled by default.
     */
    whereEntity(entity) {
        if (!this.expressionMap.mainAlias.hasMetadata)
            throw new TypeORMError(`.whereEntity method can only be used on queries which update real entity table.`);
        this.expressionMap.wheres = [];
        const entities = Array.isArray(entity) ? entity : [entity];
        entities.forEach((entity) => {
            const entityIdMap = this.expressionMap.mainAlias.metadata.getEntityIdMap(entity);
            if (!entityIdMap)
                throw new TypeORMError(`Provided entity does not have ids set, cannot perform operation.`);
            this.orWhereInIds(entityIdMap);
        });
        this.expressionMap.whereEntities = entities;
        return this;
    }
    /**
     * Indicates if entity must be updated after update operation.
     * This may produce extra query or use RETURNING / OUTPUT statement (depend on database).
     * Enabled by default.
     */
    updateEntity(enabled) {
        this.expressionMap.updateEntity = enabled;
        return this;
    }
    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------
    /**
     * Creates UPDATE express used to perform insert query.
     */
    createUpdateExpression() {
        const valuesSet = this.getValueSet();
        const metadata = this.expressionMap.mainAlias.hasMetadata
            ? this.expressionMap.mainAlias.metadata
            : undefined;
        // it doesn't make sense to update undefined properties, so just skip them
        const valuesSetNormalized = {};
        for (let key in valuesSet) {
            if (valuesSet[key] !== undefined) {
                valuesSetNormalized[key] = valuesSet[key];
            }
        }
        // prepare columns and values to be updated
        const updateColumnAndValues = [];
        const updatedColumns = [];
        if (metadata) {
            this.createPropertyPath(metadata, valuesSetNormalized).forEach((propertyPath) => {
                // todo: make this and other query builder to work with properly with tables without metadata
                const columns = metadata.findColumnsWithPropertyPath(propertyPath);
                if (columns.length <= 0) {
                    throw new EntityPropertyNotFoundError(propertyPath, metadata);
                }
                columns.forEach((column) => {
                    if (!column.isUpdate ||
                        updatedColumns.includes(column)) {
                        return;
                    }
                    updatedColumns.push(column);
                    //
                    let value = column.getEntityValue(valuesSetNormalized);
                    if (column.referencedColumn &&
                        typeof value === "object" &&
                        !(value instanceof Date) &&
                        value !== null &&
                        !Buffer.isBuffer(value)) {
                        value =
                            column.referencedColumn.getEntityValue(value);
                    }
                    else if (!(typeof value === "function")) {
                        value =
                            this.connection.driver.preparePersistentValue(value, column);
                    }
                    // todo: duplication zone
                    if (typeof value === "function") {
                        // support for SQL expressions in update query
                        updateColumnAndValues.push(this.escape(column.databaseName) +
                            " = " +
                            value());
                    }
                    else if ((this.connection.driver.options.type === "sap" ||
                        this.connection.driver.options.type ===
                            "spanner") &&
                        value === null) {
                        updateColumnAndValues.push(this.escape(column.databaseName) + " = NULL");
                    }
                    else {
                        if (this.connection.driver.options.type === "mssql") {
                            value = this.connection.driver.parametrizeValue(column, value);
                        }
                        const paramName = this.createParameter(value);
                        let expression = null;
                        if ((DriverUtils.isMySQLFamily(this.connection.driver) ||
                            this.connection.driver.options.type ===
                                "aurora-mysql") &&
                            this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            const useLegacy = this.connection.driver.options.legacySpatialSupport;
                            const geomFromText = useLegacy
                                ? "GeomFromText"
                                : "ST_GeomFromText";
                            if (column.srid != null) {
                                expression = `${geomFromText}(${paramName}, ${column.srid})`;
                            }
                            else {
                                expression = `${geomFromText}(${paramName})`;
                            }
                        }
                        else if (DriverUtils.isPostgresFamily(this.connection.driver) &&
                            this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            if (column.srid != null) {
                                expression = `ST_SetSRID(ST_GeomFromGeoJSON(${paramName}), ${column.srid})::${column.type}`;
                            }
                            else {
                                expression = `ST_GeomFromGeoJSON(${paramName})::${column.type}`;
                            }
                        }
                        else if (this.connection.driver.options.type ===
                            "mssql" &&
                            this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            expression =
                                column.type +
                                    "::STGeomFromText(" +
                                    paramName +
                                    ", " +
                                    (column.srid || "0") +
                                    ")";
                        }
                        else {
                            expression = paramName;
                        }
                        updateColumnAndValues.push(this.escape(column.databaseName) +
                            " = " +
                            expression);
                    }
                });
            });
            // Don't allow calling update only with columns that are `update: false`
            if (updateColumnAndValues.length > 0 ||
                Object.keys(valuesSetNormalized).length === 0) {
                if (metadata.versionColumn &&
                    updatedColumns.indexOf(metadata.versionColumn) === -1)
                    updateColumnAndValues.push(this.escape(metadata.versionColumn.databaseName) +
                        " = " +
                        this.escape(metadata.versionColumn.databaseName) +
                        " + 1");
                if (metadata.updateDateColumn &&
                    updatedColumns.indexOf(metadata.updateDateColumn) === -1)
                    updateColumnAndValues.push(this.escape(metadata.updateDateColumn.databaseName) +
                        " = CURRENT_TIMESTAMP"); // todo: fix issue with CURRENT_TIMESTAMP(6) being used, can "DEFAULT" be used?!
            }
        }
        else {
            Object.keys(valuesSetNormalized).map((key) => {
                let value = valuesSetNormalized[key];
                // todo: duplication zone
                if (typeof value === "function") {
                    // support for SQL expressions in update query
                    updateColumnAndValues.push(this.escape(key) + " = " + value());
                }
                else if ((this.connection.driver.options.type === "sap" ||
                    this.connection.driver.options.type === "spanner") &&
                    value === null) {
                    updateColumnAndValues.push(this.escape(key) + " = NULL");
                }
                else {
                    // we need to store array values in a special class to make sure parameter replacement will work correctly
                    // if (value instanceof Array)
                    //     value = new ArrayParameter(value);
                    const paramName = this.createParameter(value);
                    updateColumnAndValues.push(this.escape(key) + " = " + paramName);
                }
            });
        }
        if (updateColumnAndValues.length <= 0) {
            throw new UpdateValuesMissingError();
        }
        // get a table name and all column database names
        const whereExpression = this.createWhereExpression();
        const returningExpression = this.createReturningExpression("update");
        if (returningExpression === "") {
            return `UPDATE ${this.getTableName(this.getMainTableName())} SET ${updateColumnAndValues.join(", ")}${whereExpression}`; // todo: how do we replace aliases in where to nothing?
        }
        if (this.connection.driver.options.type === "mssql") {
            return `UPDATE ${this.getTableName(this.getMainTableName())} SET ${updateColumnAndValues.join(", ")} OUTPUT ${returningExpression}${whereExpression}`;
        }
        return `UPDATE ${this.getTableName(this.getMainTableName())} SET ${updateColumnAndValues.join(", ")}${whereExpression} RETURNING ${returningExpression}`;
    }
    /**
     * Creates "ORDER BY" part of SQL query.
     */
    createOrderByExpression() {
        const orderBys = this.expressionMap.orderBys;
        if (Object.keys(orderBys).length > 0)
            return (" ORDER BY " +
                Object.keys(orderBys)
                    .map((columnName) => {
                    if (typeof orderBys[columnName] === "string") {
                        return (this.replacePropertyNames(columnName) +
                            " " +
                            orderBys[columnName]);
                    }
                    else {
                        return (this.replacePropertyNames(columnName) +
                            " " +
                            orderBys[columnName].order +
                            " " +
                            orderBys[columnName].nulls);
                    }
                })
                    .join(", "));
        return "";
    }
    /**
     * Creates "LIMIT" parts of SQL query.
     */
    createLimitExpression() {
        let limit = this.expressionMap.limit;
        if (limit) {
            if (DriverUtils.isMySQLFamily(this.connection.driver) ||
                this.connection.driver.options.type === "aurora-mysql") {
                return " LIMIT " + limit;
            }
            else {
                throw new LimitOnUpdateNotSupportedError();
            }
        }
        return "";
    }
    /**
     * Gets array of values need to be inserted into the target table.
     */
    getValueSet() {
        if (typeof this.expressionMap.valuesSet === "object")
            return this.expressionMap.valuesSet;
        throw new UpdateValuesMissingError();
    }
}

//# sourceMappingURL=UpdateQueryBuilder.js.map
