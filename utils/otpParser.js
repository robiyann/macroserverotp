/**
 * Utility to extract OTP codes from WhatsApp notification text.
 * Usually looks for 6-digit numbers.
 */
function extractOTP(text) {
    if (!text) return null;
    
    // Look for 6-digit numbers
    const otpMatch = text.match(/\b\d{6}\b/);
    if (otpMatch) {
        return otpMatch[0];
    }
    
    // Look for 4-digit numbers as fallback
    const fallbackMatch = text.match(/\b\d{4}\b/);
    if (fallbackMatch) {
        return fallbackMatch[0];
    }
    
    return null;
}

module.exports = { extractOTP };
