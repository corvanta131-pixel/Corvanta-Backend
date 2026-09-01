const Company = require("../models/Company");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const { validateCompanyInput } = require("../validators/companyValidator");
const { createCompany } = require("../services/companyService");
const { logAudit } = require("../services/auditService");
const { isPlatformAdmin } = require("../utils/tenant");

exports.listCompanies = asyncHandler(async (req, res) => {
  const query = isPlatformAdmin(req.user) ? { isDeleted: false } : { _id: req.user.companyId, isDeleted: false };
  const companies = await Company.find(query).lean();

  res.status(200).json({
    success: true,
    data: companies,
  });
});

exports.createCompany = asyncHandler(async (req, res) => {
  validateCompanyInput(req.body);

  if (!isPlatformAdmin(req.user)) {
    throw new AppError(403, "Only platform administrators can create companies.");
  }

  const { name, industry, regionId, countryId, cityId } = req.body;
  const company = await createCompany({
    name,
    industry,
    regionId: regionId || null,
    countryId: countryId || null,
    cityId: cityId || null,
    ownerId: req.user ? req.user._id : null,
  });

  await logAudit({
    user: req.user,
    companyId: company._id,
    action: "company.created",
    entityType: "Company",
    entityId: company._id.toString(),
    metadata: { name: company.name },
  });

  res.status(201).json({
    success: true,
    message: "Company created successfully.",
    data: company,
  });
});
