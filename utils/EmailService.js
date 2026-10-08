const nodemailer = require("nodemailer");
require("dotenv").config();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// const generateMSCSEmail = (memberId, password, name = 'Member') => {
//   const welcomeSubject = 'MSCS - Account Registration Successful';

//   const welcomeMessage = `
//  <div style="font-family: Arial, sans-serif; padding: 20px; line-height: 1.6; margin-bottom: 100px;">
//       <h2 style="color: #4A148C;">Welcome to <span style="color: #D81B60;">MSCS</span>!</h2>

//       <p>Dear <strong>${name}</strong>,</p>

//       <p>Thank you for registering with <strong>${MSCS}</strong>.</p>

//       <p>Your registration details:
//         <span style="background-color: #E1BEE7; padding: 4px 8px; border-radius: 4px; display: inline-block; margin-top: 8px;">
//           <strong>Member ID: ${memberId}</strong><br>
//           <strong>Password: ${password}</strong>
//         </span>
//       </p>

//       <p>We are excited to have you as a member!</p>

//       <p style="margin-top: 30px;">
//         Best regards,<br/>
//         <strong>Team MSCS</strong>
//       </p>
//     </div>

//   `;

//   return { welcomeMessage, welcomeSubject };
// };

const sendMail = async (email, subject, htmlContent, textContent = '', attachments = []) => {
  try {
    const mailOptions = {
      from: `"Ecash" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: subject,
      html: htmlContent,
      text: textContent || 'Please view this email in an HTML compatible client.',
      ...(attachments.length > 0 && { attachments })
    };

    const info = await transporter.sendMail(mailOptions);
    return info;

  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}

module.exports = { sendMail };