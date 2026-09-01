const jwt = require("jsonwebtoken");
const config = require("../config/config");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const { isPlatformAdmin, getTenantFilter } = require("../utils/tenant");

async function protect(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  if (!token) {
    return next(new AppError(401, "Authentication token is required."));
  }

  try {
    const decoded = jwt.verify(token, config.JWT_ACCESS_SECRET);

    if (decoded.type !== "access") {
      return next(new AppError(401, "Invalid token type."));
    }

    const user = await User.findById(decoded.sub).populate("roleId");

    if (!user || user.isDeleted || user.status !== "active") {
      return next(new AppError(401, "User not found or no longer active."));
    }

    if (user.companyId && decoded.companyId && user.companyId.toString() !== decoded.companyId) {
      return next(new AppError(401, "Token company mismatch."));
    }

    req.user = user;
    req.companyId = user.companyId ? user.companyId.toString() : null;
    req.user.companyId = user.companyId;
    req.user.role = user.roleId || null;
    if (user.roleId) {
      req.user.roleSlug = user.roleId.slug;
    }

    return next();
  } catch (error) {
    return next(new AppError(401, "Invalid or expired access token."));
  }
}

function authorize(...allowedRoles) {
  return (req, res, next) => {
    const userRoleSlug = req.user?.roleId?.slug || req.user?.role?.slug || req.user?.roleSlug || "";

    if (!allowedRoles.length || allowedRoles.includes(userRoleSlug)) {
      return next();
    }

    return next(new AppError(403, "You do not have permission to perform this action."));
  };
}

function requiresPermission(requiredPermission) {
  return (req, res, next) => {
    const permissions = req.user?.roleId?.permissions || req.user?.role?.permissions || [];
    const hasPermission = permissions.includes(requiredPermission) || permissions.includes("*") || isPlatformAdmin(req.user);

    if (hasPermission) {
      return next();
    }

    return next(new AppError(403, `Permission required: ${requiredPermission}`));
  };
}

function requireCompanyAccess(modelName, options = {}) {
  const resourceCompanyField = options.resourceCompanyField || "companyId";
  const getCompanyId = options.getCompanyId || ((req) => req.companyId || req.user?.companyId);

  return async function companyAccessMiddleware(req, res, next) {
    try {
      if (!req.user) {
        return next(new AppError(401, "Authentication required."));
      }

      if (isPlatformAdmin(req.user)) {
        return next();
      }

      const requestCompanyId = getCompanyId(req);
      if (!requestCompanyId) {
        return next(new AppError(403, "Missing company context."));
      }

      const targetId = req.params.id || req.body?.companyId || req.query?.companyId;

      if (!targetId) {
        if (req.method === "GET" || req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") {
          req.companyScope = getTenantFilter(req.user, resourceCompanyField);
          return next();
        }
      }

      const resource = await modelName.findOne({
        _id: targetId,
        [resourceCompanyField]: requestCompanyId,
      });

      if (!resource) {
        return next(new AppError(403, "You do not have access to this company's data."));
      }

      req.resource = resource;
      req.companyScope = getTenantFilter(req.user, resourceCompanyField);
      return next();
    } catch (error) {
      return next(new AppError(500, "Company access check failed."));
    }
  };
}

module.exports = { protect, authorize, requiresPermission, requireCompanyAccess };
