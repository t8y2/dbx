/**
 * Static MongoDB operator metadata for editor completion, distilled from the
 * MongoDB manual (Query and Projection Operators, Update Operators, Aggregation
 * Pipeline Stages / Operators). Kept offline and lightweight: each entry carries
 * only what the completion list renders — a label, a one-line `detail`, and the
 * text to insert.
 *
 * `apply` is the text inserted when the item is accepted. Entries containing a
 * `${…}` placeholder are inserted as CodeMirror snippets (see
 * `mongoOperatorItemType`); the rest are inserted verbatim. Every `apply` here
 * writes the operator *and* its `:` separator, because these items are only ever
 * offered in key position inside an object literal.
 *
 * The tables are deliberately grouped by where they may legally appear, so the
 * completion engine never has to filter one flat list by context:
 *   QUERY_OPERATORS      → filter documents (`find`, `$match`, …)
 *   UPDATE_OPERATORS     → update documents (`updateOne`, `findOneAndUpdate`, …)
 *   PUSH_MODIFIERS       → the object value of `$push` / `$addToSet`
 *   PIPELINE_STAGES      → elements of an aggregation pipeline array
 *   ACCUMULATORS         → the output fields of `$group`
 *   EXPRESSION_OPERATORS → aggregation expression position (`$project`, `$expr`, …)
 */

export interface MongoOperatorSpec {
  label: string;
  detail: string;
  apply: string;
}

type Spec = [label: string, detail: string, apply: string];

function specs(entries: readonly Spec[]): MongoOperatorSpec[] {
  return entries.map(([label, detail, apply]) => ({ label, detail, apply }));
}

/** Snippet placeholders only work for `snippet`/`function` completions; plain text is inserted as-is. */
export function mongoOperatorItemType(apply: string): "snippet" | "keyword" {
  return apply.includes("${") ? "snippet" : "keyword";
}

export const QUERY_OPERATORS: MongoOperatorSpec[] = specs([
  ["$eq", "Matches values equal to a value", "$eq: ${}"],
  ["$ne", "Matches values not equal to a value", "$ne: ${}"],
  ["$gt", "Matches values greater than a value", "$gt: ${}"],
  ["$gte", "Matches values greater than or equal to a value", "$gte: ${}"],
  ["$lt", "Matches values less than a value", "$lt: ${}"],
  ["$lte", "Matches values less than or equal to a value", "$lte: ${}"],
  ["$in", "Matches any value in an array", "$in: [${}]"],
  ["$nin", "Matches no value in an array", "$nin: [${}]"],
  ["$and", "Joins clauses with a logical AND", "$and: [${}]"],
  ["$or", "Joins clauses with a logical OR", "$or: [${}]"],
  ["$nor", "Joins clauses with a logical NOR", "$nor: [${}]"],
  ["$not", "Inverts the effect of a query expression", "$not: { ${} }"],
  ["$exists", "Matches documents that have the field", "$exists: true"],
  ["$type", "Matches documents by BSON type", '$type: "${string}"'],
  ["$regex", "Matches a regular expression", '$regex: "${pattern}"'],
  ["$text", "Performs a text search", '$text: { $search: "${text}" }'],
  ["$expr", "Uses aggregation expressions in a query", "$expr: { ${} }"],
  ["$jsonSchema", "Matches documents against a JSON schema", "$jsonSchema: { ${} }"],
  ["$mod", "Matches values by modulo division", "$mod: [${divisor}, ${remainder}]"],
  ["$where", "Matches with a JavaScript predicate", '$where: "${expression}"'],
  ["$all", "Matches arrays containing all the values", "$all: [${}]"],
  ["$elemMatch", "Matches arrays with an element matching all criteria", "$elemMatch: { ${} }"],
  ["$size", "Matches arrays of a given length", "$size: ${}"],
  ["$bitsAllSet", "Matches numbers with all the given bits set", "$bitsAllSet: [${}]"],
  ["$bitsAnySet", "Matches numbers with any of the given bits set", "$bitsAnySet: [${}]"],
  ["$bitsAllClear", "Matches numbers with all the given bits clear", "$bitsAllClear: [${}]"],
  ["$bitsAnyClear", "Matches numbers with any of the given bits clear", "$bitsAnyClear: [${}]"],
  ["$geoWithin", "Matches geometry contained within a shape", "$geoWithin: { ${} }"],
  ["$geoIntersects", "Matches geometry intersecting a shape", "$geoIntersects: { ${} }"],
  ["$near", "Matches points near a point, nearest first", "$near: { ${} }"],
  ["$nearSphere", "Matches points near a point on a sphere", "$nearSphere: { ${} }"],
]);

export const UPDATE_OPERATORS: MongoOperatorSpec[] = specs([
  ["$set", "Sets field values", "$set: { ${} }"],
  ["$unset", "Removes fields", '$unset: { ${field}: "" }'],
  ["$setOnInsert", "Sets field values only when an upsert inserts", "$setOnInsert: { ${} }"],
  ["$inc", "Increments field values", "$inc: { ${field}: 1 }"],
  ["$mul", "Multiplies field values", "$mul: { ${field}: 2 }"],
  ["$min", "Updates only when the new value is lower", "$min: { ${field}: ${} }"],
  ["$max", "Updates only when the new value is higher", "$max: { ${field}: ${} }"],
  ["$rename", "Renames fields", '$rename: { ${field}: "${newName}" }'],
  ["$currentDate", "Sets fields to the current date", "$currentDate: { ${field}: true }"],
  ["$push", "Appends values to an array", "$push: { ${field}: ${} }"],
  ["$addToSet", "Appends values to an array without duplicates", "$addToSet: { ${field}: ${} }"],
  ["$pop", "Removes the first or last element of an array", "$pop: { ${field}: 1 }"],
  ["$pull", "Removes array elements matching a condition", "$pull: { ${field}: ${} }"],
  ["$pullAll", "Removes all the listed values from an array", "$pullAll: { ${field}: [${}] }"],
  ["$bit", "Performs a bitwise update", "$bit: { ${field}: { and: ${} } }"],
]);

/** Valid inside the object value of `$push` / `$addToSet`, and nowhere else. */
export const PUSH_MODIFIERS: MongoOperatorSpec[] = specs([
  ["$each", "Appends multiple values", "$each: [${}]"],
  ["$slice", "Limits the array length after the push", "$slice: ${}"],
  ["$sort", "Sorts the array elements after the push", "$sort: { ${field}: 1 }"],
  ["$position", "Insert position for $each", "$position: 0"],
]);

export const PIPELINE_STAGES: MongoOperatorSpec[] = specs([
  ["$match", "Filters documents", "$match: { ${} }"],
  ["$project", "Reshapes documents", "$project: { ${} }"],
  ["$group", "Groups documents by a key", '$group: { _id: "$${field}", count: { $sum: 1 } }'],
  ["$sort", "Sorts documents", "$sort: { ${field}: -1 }"],
  ["$limit", "Limits the number of documents", "$limit: 10"],
  ["$skip", "Skips documents", "$skip: 0"],
  ["$count", "Counts documents into a single field", '$count: "${total}"'],
  ["$unwind", "Deconstructs an array field into one document per element", '$unwind: "$${field}"'],
  ["$lookup", "Joins another collection", '$lookup: { from: "${collection}", localField: "${field}", foreignField: "_id", as: "${as}" }'],
  ["$addFields", "Adds new fields to documents", "$addFields: { ${} }"],
  ["$set", "Adds new fields to documents (alias of $addFields)", "$set: { ${} }"],
  ["$unset", "Removes fields from documents", '$unset: "${field}"'],
  ["$replaceRoot", "Promotes a subdocument to the top level", '$replaceRoot: { newRoot: "$${field}" }'],
  ["$replaceWith", "Promotes a subdocument to the top level", '$replaceWith: "$${field}"'],
  ["$facet", "Runs multiple pipelines over the same input", "$facet: { ${name}: [${}] }"],
  ["$sortByCount", "Groups by a value and counts, highest first", '$sortByCount: "$${field}"'],
  ["$bucket", "Groups documents into user-defined buckets", '$bucket: { groupBy: "$${field}", boundaries: [${}], default: "other" }'],
  ["$bucketAuto", "Groups documents into evenly distributed buckets", '$bucketAuto: { groupBy: "$${field}", buckets: 5 }'],
  ["$sample", "Randomly selects documents", "$sample: { size: 10 }"],
  ["$unionWith", "Combines results with another collection", '$unionWith: { coll: "${collection}", pipeline: [${}] }'],
  ["$graphLookup", "Performs a recursive search on a collection", '$graphLookup: { from: "${collection}", startWith: "$${field}", connectFromField: "${field}", connectToField: "_id", as: "${as}" }'],
  ["$geoNear", "Orders documents by proximity to a point", '$geoNear: { near: { type: "Point", coordinates: [0, 0] }, distanceField: "${distance}" }'],
  ["$setWindowFields", "Adds fields computed over a window of documents", '$setWindowFields: { partitionBy: "$${field}", sortBy: { ${field}: 1 }, output: {} }'],
  ["$densify", "Fills gaps in a sequence of field values", '$densify: { field: "${field}", range: { step: 1, unit: "${unit}" } }'],
  ["$fill", "Fills null or missing field values", "$fill: { output: { ${field}: { value: ${} } } }"],
  ["$documents", "Returns literal documents", "$documents: [${}]"],
  ["$redact", "Restricts document content based on a condition", "$redact: { ${} }"],
  ["$out", "Writes the results to a collection", '$out: "${collection}"'],
  ["$merge", "Merges the results into a collection", '$merge: { into: "${collection}" }'],
  ["$collStats", "Returns statistics about the collection", "$collStats: { ${} }"],
  ["$indexStats", "Returns index usage statistics", "$indexStats: {}"],
  ["$planCacheStats", "Returns plan cache information", "$planCacheStats: {}"],
]);

export const ACCUMULATORS: MongoOperatorSpec[] = specs([
  ["$sum", "Sums values", "$sum: 1"],
  ["$avg", "Averages values", '$avg: "$${field}"'],
  ["$min", "Returns the lowest value", '$min: "$${field}"'],
  ["$max", "Returns the highest value", '$max: "$${field}"'],
  ["$count", "Counts the documents in the group", "$count: {}"],
  ["$first", "Returns the first value in the group", '$first: "$${field}"'],
  ["$last", "Returns the last value in the group", '$last: "$${field}"'],
  ["$push", "Collects values into an array", '$push: "$${field}"'],
  ["$addToSet", "Collects unique values into an array", '$addToSet: "$${field}"'],
  ["$mergeObjects", "Merges documents into one", '$mergeObjects: "$${field}"'],
  ["$stdDevPop", "Population standard deviation", '$stdDevPop: "$${field}"'],
  ["$stdDevSamp", "Sample standard deviation", '$stdDevSamp: "$${field}"'],
  ["$top", "Returns the top element by a sort order", '$top: { sortBy: { ${field}: -1 }, output: "$${field}" }'],
  ["$topN", "Returns the top N elements by a sort order", '$topN: { n: 3, sortBy: { ${field}: -1 }, output: "$${field}" }'],
  ["$bottom", "Returns the bottom element by a sort order", '$bottom: { sortBy: { ${field}: -1 }, output: "$${field}" }'],
  ["$bottomN", "Returns the bottom N elements by a sort order", '$bottomN: { n: 3, sortBy: { ${field}: -1 }, output: "$${field}" }'],
  ["$firstN", "Returns the first N values in the group", '$firstN: { input: "$${field}", n: 3 }'],
  ["$lastN", "Returns the last N values in the group", '$lastN: { input: "$${field}", n: 3 }'],
  ["$maxN", "Returns the N highest values", '$maxN: { input: "$${field}", n: 3 }'],
  ["$minN", "Returns the N lowest values", '$minN: { input: "$${field}", n: 3 }'],
  ["$median", "Approximates the median", '$median: { input: "$${field}", method: "approximate" }'],
  ["$percentile", "Approximates the requested percentiles", '$percentile: { input: "$${field}", p: [0.95], method: "approximate" }'],
]);

export const EXPRESSION_OPERATORS: MongoOperatorSpec[] = specs([
  // Conditional
  ["$cond", "Returns one of two values from a condition", "$cond: { if: ${}, then: ${}, else: ${} }"],
  ["$ifNull", "Returns the first non-null value", "$ifNull: [${}, ${}]"],
  ["$switch", "Evaluates branches in order", "$switch: { branches: [{ case: ${}, then: ${} }], default: ${} }"],
  // Comparison / boolean
  ["$eq", "Returns true when the values are equal", "$eq: [${}, ${}]"],
  ["$ne", "Returns true when the values differ", "$ne: [${}, ${}]"],
  ["$gt", "Returns true when the first value is greater", "$gt: [${}, ${}]"],
  ["$gte", "Returns true when the first value is greater or equal", "$gte: [${}, ${}]"],
  ["$lt", "Returns true when the first value is less", "$lt: [${}, ${}]"],
  ["$lte", "Returns true when the first value is less or equal", "$lte: [${}, ${}]"],
  ["$cmp", "Compares two values and returns -1, 0 or 1", "$cmp: [${}, ${}]"],
  ["$and", "Logical AND", "$and: [${}]"],
  ["$or", "Logical OR", "$or: [${}]"],
  ["$not", "Logical NOT", "$not: [${}]"],
  // Arithmetic
  ["$add", "Adds numbers or a number to a date", "$add: [${}, ${}]"],
  ["$subtract", "Subtracts two numbers or dates", "$subtract: [${}, ${}]"],
  ["$multiply", "Multiplies numbers", "$multiply: [${}, ${}]"],
  ["$divide", "Divides two numbers", "$divide: [${}, ${}]"],
  ["$mod", "Returns the remainder of a division", "$mod: [${}, ${}]"],
  ["$abs", "Absolute value", "$abs: ${}"],
  ["$ceil", "Rounds up to the next integer", "$ceil: ${}"],
  ["$floor", "Rounds down to the previous integer", "$floor: ${}"],
  ["$round", "Rounds to a number of decimal places", "$round: [${}, 0]"],
  ["$trunc", "Truncates to a number of decimal places", "$trunc: [${}, 0]"],
  ["$pow", "Raises a number to an exponent", "$pow: [${}, 2]"],
  ["$sqrt", "Square root", "$sqrt: ${}"],
  ["$ln", "Natural logarithm", "$ln: ${}"],
  ["$log", "Logarithm in the given base", "$log: [${}, 10]"],
  ["$log10", "Base 10 logarithm", "$log10: ${}"],
  ["$exp", "Raises e to an exponent", "$exp: ${}"],
  // Strings
  ["$concat", "Concatenates strings", "$concat: [${}, ${}]"],
  ["$split", "Splits a string on a delimiter", '$split: [${}, "${,}"]'],
  ["$substr", "Returns a substring", "$substr: [${}, 0, 1]"],
  ["$substrBytes", "Returns a substring by byte index", "$substrBytes: [${}, 0, 1]"],
  ["$substrCP", "Returns a substring by code point index", "$substrCP: [${}, 0, 1]"],
  ["$strLenCP", "Number of code points in a string", "$strLenCP: ${}"],
  ["$strLenBytes", "Number of bytes in a string", "$strLenBytes: ${}"],
  ["$strcasecmp", "Case-insensitive string comparison", "$strcasecmp: [${}, ${}]"],
  ["$toLower", "Converts a string to lower case", "$toLower: ${}"],
  ["$toUpper", "Converts a string to upper case", "$toUpper: ${}"],
  ["$trim", "Removes whitespace from both ends", "$trim: { input: ${} }"],
  ["$ltrim", "Removes whitespace from the start", "$ltrim: { input: ${} }"],
  ["$rtrim", "Removes whitespace from the end", "$rtrim: { input: ${} }"],
  ["$replaceOne", "Replaces the first match in a string", "$replaceOne: { input: ${}, find: ${}, replacement: ${} }"],
  ["$replaceAll", "Replaces every match in a string", "$replaceAll: { input: ${}, find: ${}, replacement: ${} }"],
  ["$regexMatch", "Returns true when a regex matches", '$regexMatch: { input: ${}, regex: "${pattern}" }'],
  ["$regexFind", "Returns the first regex match", '$regexFind: { input: ${}, regex: "${pattern}" }'],
  ["$regexFindAll", "Returns every regex match", '$regexFindAll: { input: ${}, regex: "${pattern}" }'],
  ["$indexOfCP", "Position of a substring by code point", "$indexOfCP: [${}, ${}]"],
  ["$indexOfBytes", "Position of a substring by byte", "$indexOfBytes: [${}, ${}]"],
  // Arrays
  ["$size", "Number of elements in an array", "$size: ${}"],
  ["$arrayElemAt", "Element at an array index", "$arrayElemAt: [${}, 0]"],
  ["$first", "First element of an array", "$first: ${}"],
  ["$last", "Last element of an array", "$last: ${}"],
  ["$slice", "Returns a subset of an array", "$slice: [${}, 3]"],
  ["$in", "Returns true when a value is in an array", "$in: [${}, ${}]"],
  ["$indexOfArray", "Position of a value in an array", "$indexOfArray: [${}, ${}]"],
  ["$concatArrays", "Concatenates arrays", "$concatArrays: [${}, ${}]"],
  ["$filter", "Selects array elements matching a condition", '$filter: { input: ${}, as: "${item}", cond: ${} }'],
  ["$map", "Applies an expression to each array element", '$map: { input: ${}, as: "${item}", in: ${} }'],
  ["$reduce", "Folds an array into a single value", "$reduce: { input: ${}, initialValue: ${}, in: ${} }"],
  ["$reverseArray", "Reverses an array", "$reverseArray: ${}"],
  ["$sortArray", "Sorts an array", "$sortArray: { input: ${}, sortBy: 1 }"],
  ["$range", "Generates a sequence of numbers", "$range: [0, 10]"],
  ["$zip", "Merges arrays element by element", "$zip: { inputs: [${}] }"],
  ["$isArray", "Returns true when the value is an array", "$isArray: ${}"],
  ["$arrayToObject", "Converts an array of pairs to a document", "$arrayToObject: ${}"],
  ["$objectToArray", "Converts a document to an array of pairs", "$objectToArray: ${}"],
  ["$setUnion", "Union of arrays as sets", "$setUnion: [${}, ${}]"],
  ["$setIntersection", "Intersection of arrays as sets", "$setIntersection: [${}, ${}]"],
  ["$setDifference", "Difference of arrays as sets", "$setDifference: [${}, ${}]"],
  ["$setEquals", "Returns true when the sets are equal", "$setEquals: [${}, ${}]"],
  ["$setIsSubset", "Returns true when the first set is a subset", "$setIsSubset: [${}, ${}]"],
  ["$allElementsTrue", "Returns true when every element is true", "$allElementsTrue: [${}]"],
  ["$anyElementTrue", "Returns true when any element is true", "$anyElementTrue: [${}]"],
  // Dates
  ["$dateToString", "Formats a date as a string", '$dateToString: { format: "%Y-%m-%d", date: "$${field}" }'],
  ["$dateFromString", "Parses a string into a date", "$dateFromString: { dateString: ${} }"],
  ["$dateToParts", "Splits a date into its parts", '$dateToParts: { date: "$${field}" }'],
  ["$dateFromParts", "Builds a date from its parts", "$dateFromParts: { year: ${}, month: ${}, day: ${} }"],
  ["$dateAdd", "Adds a time unit to a date", '$dateAdd: { startDate: "$${field}", unit: "day", amount: 1 }'],
  ["$dateSubtract", "Subtracts a time unit from a date", '$dateSubtract: { startDate: "$${field}", unit: "day", amount: 1 }'],
  ["$dateDiff", "Difference between two dates", '$dateDiff: { startDate: ${}, endDate: ${}, unit: "day" }'],
  ["$dateTrunc", "Truncates a date to a time unit", '$dateTrunc: { date: "$${field}", unit: "day" }'],
  ["$year", "Year of a date", '$year: "$${field}"'],
  ["$month", "Month of a date", '$month: "$${field}"'],
  ["$dayOfMonth", "Day of the month of a date", '$dayOfMonth: "$${field}"'],
  ["$dayOfWeek", "Day of the week of a date", '$dayOfWeek: "$${field}"'],
  ["$dayOfYear", "Day of the year of a date", '$dayOfYear: "$${field}"'],
  ["$week", "Week of the year of a date", '$week: "$${field}"'],
  ["$hour", "Hour of a date", '$hour: "$${field}"'],
  ["$minute", "Minute of a date", '$minute: "$${field}"'],
  ["$second", "Second of a date", '$second: "$${field}"'],
  ["$millisecond", "Millisecond of a date", '$millisecond: "$${field}"'],
  ["$isoWeek", "ISO week number of a date", '$isoWeek: "$${field}"'],
  ["$isoWeekYear", "ISO week-numbering year of a date", '$isoWeekYear: "$${field}"'],
  ["$isoDayOfWeek", "ISO day of the week of a date", '$isoDayOfWeek: "$${field}"'],
  // Types and misc
  ["$type", "Returns the BSON type of a value", "$type: ${}"],
  ["$convert", "Converts a value to a given type", '$convert: { input: ${}, to: "${string}" }'],
  ["$toString", "Converts a value to a string", "$toString: ${}"],
  ["$toInt", "Converts a value to an integer", "$toInt: ${}"],
  ["$toLong", "Converts a value to a 64-bit integer", "$toLong: ${}"],
  ["$toDouble", "Converts a value to a double", "$toDouble: ${}"],
  ["$toDecimal", "Converts a value to a decimal", "$toDecimal: ${}"],
  ["$toBool", "Converts a value to a boolean", "$toBool: ${}"],
  ["$toDate", "Converts a value to a date", "$toDate: ${}"],
  ["$toObjectId", "Converts a value to an ObjectId", "$toObjectId: ${}"],
  ["$isNumber", "Returns true when the value is a number", "$isNumber: ${}"],
  ["$literal", "Returns a value without parsing it", "$literal: ${}"],
  ["$mergeObjects", "Merges documents into one", "$mergeObjects: [${}, ${}]"],
  ["$getField", "Reads a field, including names starting with $", '$getField: "${field}"'],
  ["$setField", "Writes a field, including names starting with $", '$setField: { field: "${field}", input: "$$ROOT", value: ${} }'],
  ["$let", "Binds variables for use in an expression", "$let: { vars: { ${name}: ${} }, in: ${} }"],
  ["$rand", "Returns a random float between 0 and 1", "$rand: {}"],
]);

/** Option keys accepted by the stages whose shape is a fixed set of names. */
export const STAGE_OPTION_KEYS: Record<string, MongoOperatorSpec[]> = {
  $lookup: specs([
    ["from", "Collection to join", 'from: "${collection}"'],
    ["localField", "Field on the input documents", 'localField: "${field}"'],
    ["foreignField", "Field on the joined collection", 'foreignField: "_id"'],
    ["as", "Output array field", 'as: "${as}"'],
    ["let", "Variables for the joined pipeline", "let: { ${name}: ${} }"],
    ["pipeline", "Pipeline to run on the joined collection", "pipeline: [${}]"],
  ]),
  $graphLookup: specs([
    ["from", "Collection to search", 'from: "${collection}"'],
    ["startWith", "Expression to start the search from", 'startWith: "$${field}"'],
    ["connectFromField", "Field to recurse from", 'connectFromField: "${field}"'],
    ["connectToField", "Field to match against", 'connectToField: "_id"'],
    ["as", "Output array field", 'as: "${as}"'],
    ["maxDepth", "Maximum recursion depth", "maxDepth: 3"],
    ["depthField", "Field holding the recursion depth", 'depthField: "${depth}"'],
    ["restrictSearchWithMatch", "Extra filter on the searched documents", "restrictSearchWithMatch: { ${} }"],
  ]),
  $unwind: specs([
    ["path", "Array field to unwind", 'path: "$${field}"'],
    ["includeArrayIndex", "Field holding the array index", 'includeArrayIndex: "${index}"'],
    ["preserveNullAndEmptyArrays", "Keep documents with a missing or empty array", "preserveNullAndEmptyArrays: true"],
  ]),
  $merge: specs([
    ["into", "Target collection", 'into: "${collection}"'],
    ["on", "Fields identifying a document", 'on: "_id"'],
    ["let", "Variables for whenMatched", "let: { ${name}: ${} }"],
    ["whenMatched", "Action when a document matches", 'whenMatched: "${merge}"'],
    ["whenNotMatched", "Action when no document matches", 'whenNotMatched: "${insert}"'],
  ]),
  $bucket: specs([
    ["groupBy", "Expression to group by", 'groupBy: "$${field}"'],
    ["boundaries", "Bucket boundaries", "boundaries: [${}]"],
    ["default", "Bucket for values outside the boundaries", 'default: "${other}"'],
    ["output", "Accumulators for each bucket", "output: { ${} }"],
  ]),
  $bucketAuto: specs([
    ["groupBy", "Expression to group by", 'groupBy: "$${field}"'],
    ["buckets", "Number of buckets", "buckets: 5"],
    ["output", "Accumulators for each bucket", "output: { ${} }"],
    ["granularity", "Preferred number series", 'granularity: "${R20}"'],
  ]),
  $sample: specs([["size", "Number of documents to return", "size: 10"]]),
  $unionWith: specs([
    ["coll", "Collection to union with", 'coll: "${collection}"'],
    ["pipeline", "Pipeline to run on that collection", "pipeline: [${}]"],
  ]),
  $setWindowFields: specs([
    ["partitionBy", "Expression to partition by", 'partitionBy: "$${field}"'],
    ["sortBy", "Sort order within a partition", "sortBy: { ${field}: 1 }"],
    ["output", "Window accumulators", "output: { ${} }"],
  ]),
  $geoNear: specs([
    ["near", "Point to measure from", 'near: { type: "Point", coordinates: [0, 0] }'],
    ["distanceField", "Field holding the computed distance", 'distanceField: "${distance}"'],
    ["maxDistance", "Maximum distance in meters", "maxDistance: 1000"],
    ["minDistance", "Minimum distance in meters", "minDistance: 0"],
    ["query", "Extra filter on the documents", "query: { ${} }"],
    ["spherical", "Use spherical geometry", "spherical: true"],
    ["key", "Geospatial index to use", 'key: "${field}"'],
    ["includeLocs", "Field holding the matched location", 'includeLocs: "${location}"'],
  ]),
  $replaceRoot: specs([["newRoot", "Expression producing the new root document", 'newRoot: "$${field}"']]),
};

/** Literal values that are worth completing in value position. */
export const VALUE_SNIPPETS: MongoOperatorSpec[] = specs([
  ["ObjectId", "MongoDB ObjectId value", 'ObjectId("${id}")'],
  ["ISODate", "MongoDB ISODate value", 'ISODate("${date}")'],
  ["new Date", "JavaScript date value", 'new Date("${date}")'],
  ["NumberLong", "64-bit integer value", 'NumberLong("${value}")'],
  ["null", "Null value", "null"],
  ["true", "Boolean true", "true"],
  ["false", "Boolean false", "false"],
]);

/**
 * Everyday operators, floated above the long tail. Without this the lists sort
 * alphabetically once the user has typed only `$`, which buries `$eq` and
 * `$match` under `$bitsAllClear` and `$bucketAuto`. Matched per table, so a
 * label common in one position (`$set` as an update operator) does not have to
 * be common in another.
 */
export const COMMON_OPERATORS: ReadonlySet<string> = new Set([
  // query
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$and",
  "$or",
  "$not",
  "$exists",
  "$regex",
  "$elemMatch",
  "$expr",
  // update
  "$set",
  "$unset",
  "$inc",
  "$push",
  "$pull",
  "$addToSet",
  "$each",
  // stages
  "$match",
  "$group",
  "$project",
  "$sort",
  "$limit",
  "$skip",
  "$lookup",
  "$unwind",
  "$count",
  "$addFields",
  // accumulators
  "$sum",
  "$avg",
  "$first",
  "$last",
  "$max",
  "$min",
  // expressions
  "$cond",
  "$ifNull",
  "$concat",
  "$toString",
  "$dateToString",
  "$size",
  "$arrayElemAt",
  "$add",
  "$subtract",
  "$multiply",
  "$filter",
  "$map",
  // values
  "ObjectId",
  "ISODate",
]);

export const UPDATE_OPERATOR_LABELS: ReadonlySet<string> = new Set(UPDATE_OPERATORS.map((operator) => operator.label));
