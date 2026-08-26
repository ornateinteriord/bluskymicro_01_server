const MemberModel = require("../../../models/Users/Member");
const PayoutModel = require("../../../models/Payout/Payout");
const AddOnRequestModel = require("../../../models/Packages/AddOnRequest");
const AddOnPackageModel = require("../../../models/Packages/AddOnPackage");
const TransactionModel = require("../../../models/Transaction/Transaction");
const mlmService = require("../mlmService/mlmService");
const moment = require("moment");
const mongoose = require("mongoose");

/**
 * Check if the given date is a weekend (Saturday or Sunday)
 */
const isWeekend = (date) => {
    const day = moment(date).utcOffset("+05:30").day();
    return day === 0 || day === 6; // 0 = Sunday, 6 = Saturday
};

/**
 * Calculate the number of working days (Mon-Fri) in a given window
 */
const getWorkingDaysInWindow = (startDate, calendarDays) => {
    let count = 0;
    const start = moment(startDate);
    for (let i = 0; i < calendarDays; i++) {
        const current = moment(start).add(i, "days");
        const day = current.day();
        if (day !== 0 && day !== 6) {
            count++;
        }
    }
    return count;
};

// Lock management for global ROI processing
let isROIProcessing = false;
let lastGlobalProcessTime = 0;
const GLOBAL_LOCK_TIMEOUT = 30 * 60 * 1000; // 30 minutes

/**
 * Process daily ROI for all eligible members (Smart Catch-up)
 * Handles multi-day gaps automatically with production-grade safety.
 * @param {string|null} targetMemberId - Optional ID to process only a specific member
 */
const processDailyROI = async (targetMemberId = null, customToday = null) => {
    console.log("ROI processing is currently disabled.");
    return {
        success: true,
        baseProcessedCount: 0,
        addonProcessedCount: 0,
        processedCount: 0,
        message: "ROI processing is currently disabled."
    };
};

/**
 * Process ROI for a single member (typically called during activation)
 */
const processMemberROI = async (member) => {
    console.log(`ROI processing is disabled for member ${member.Member_id}.`);
    return { success: true, amount: 0, message: "ROI disabled" };
};

/**
 * Process ROI for a single Add-On package (typically called during approval)
 */
const processAddOnROI = async (addon, member) => {
    console.log(`ROI processing is disabled for addon ${addon.package_id}.`);
    return { success: true, amount: 0, message: "ROI disabled" };
};

module.exports = { processDailyROI, processMemberROI, processAddOnROI, isWeekend };
