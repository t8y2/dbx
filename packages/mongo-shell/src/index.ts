export {
  chainedMethodCallPattern,
  escapeRegExp,
  findChainedMethodCallIndex,
  findMatchingParen,
  hasUnclosedMongoDelimiters,
  normalizeJsonArgument,
  parseCollectionMethodTarget,
  parseMongoObjectArgument,
  quoteUnquotedObjectKeys,
  splitTopLevel,
  stripMongoJsonComments,
  trimMongoOuterComments,
} from "./json.js";

export {
  describeMongoCommandParseFailure,
  MONGO_SHELL_COMMAND_HINT,
  parseMongoAggregateCommand,
  type MongoAggregateCommand,
} from "./aggregate.js";
