/**
 * Zod validation middleware.
 *
 * Replaces req.body/query/params with the PARSED result, so downstream handlers
 * get coerced types (numbers as numbers, dates as Dates) and stripped unknown
 * keys rather than raw strings.
 */
export function validate({ body, query, params }) {
  return (req, res, next) => {
    try {
      if (params) req.params = params.parse(req.params);
      if (query) req.validatedQuery = query.parse(req.query);
      if (body) req.body = body.parse(req.body);
      next();
    } catch (err) {
      next(err); // ZodError - errorHandler turns it into a 400 with field details
    }
  };
}
