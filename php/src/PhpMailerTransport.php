<?php

declare(strict_types=1);

namespace PixelMani;

use PHPMailer\PHPMailer\Exception as PHPMailerException;
use PHPMailer\PHPMailer\PHPMailer;

/**
 * Sends a ContactMessage through authenticated SMTP with PHPMailer
 * (php/vendor, installed with Composer and shipped with the deployment, so
 * the host needs no Composer).
 *
 * PHPMailer encodes every header and body part (UTF-8). From and the envelope
 * sender are always CONTACT_FROM; the visitor only appears as Reply-To.
 */
final class PhpMailerTransport implements MailTransport
{
    private const TIMEOUT_SECONDS = 15;

    private function __construct(private readonly ContactConfig $config) {}

    /** Loads PHPMailer lazily: only the contact endpoint needs it. */
    public static function create(ContactConfig $config, string $appRoot): self
    {
        $autoload = $appRoot . '/vendor/autoload.php';
        if (!class_exists(PHPMailer::class)) {
            if (!is_file($autoload)) {
                throw new \RuntimeException('PHPMailer is not installed (run composer install in php/).');
            }
            require_once $autoload;
        }
        return new self($config);
    }

    public function send(ContactMessage $message): void
    {
        $mail = new PHPMailer(true);

        try {
            $mail->isSMTP();
            $mail->Host = $this->config->smtpHost;
            $mail->Port = $this->config->smtpPort;
            $mail->Timeout = self::TIMEOUT_SECONDS;
            $mail->SMTPDebug = 0;

            switch ($this->config->encryption) {
                case 'tls':
                    $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
                    break;
                case 'ssl':
                    $mail->SMTPSecure = PHPMailer::ENCRYPTION_SMTPS;
                    break;
                default: // 'none': local development (Mailpit) only, enforced by ContactConfig
                    $mail->SMTPSecure = '';
                    $mail->SMTPAutoTLS = false;
            }

            if ($this->config->username !== null) {
                $mail->SMTPAuth = true;
                $mail->Username = $this->config->username;
                $mail->Password = (string) $this->config->password();
            }

            $mail->CharSet = PHPMailer::CHARSET_UTF8;
            $mail->Encoding = PHPMailer::ENCODING_QUOTED_PRINTABLE;
            $mail->XMailer = ' '; // do not advertise the mailer library

            $mail->setFrom($message->from, $message->fromName); // also the envelope sender
            $mail->addAddress($message->to);
            $mail->addReplyTo($message->replyTo, $message->replyToName);

            $mail->Subject = $message->subject;
            $mail->isHTML(true);
            $mail->Body = $message->htmlBody;
            $mail->AltBody = $message->textBody;

            $mail->send();
        } catch (PHPMailerException $e) {
            throw new MailTransportException(self::category($e->getMessage() . ' ' . $mail->ErrorInfo));
        } finally {
            $mail->smtpClose();
        }
    }

    /** Coarse failure class for the log; never the raw text (it can contain addresses). */
    public static function category(string $error): string
    {
        return match (true) {
            (bool) preg_match('/authenticat/i', $error) => 'auth',
            (bool) preg_match('/starttls|tls|ssl|certificate|crypto/i', $error) => 'tls',
            (bool) preg_match('/connect|timed? ?out|could not resolve|getaddrinfo/i', $error) => 'connect',
            (bool) preg_match('/recipient|from address|sender|data not accepted|rejected/i', $error) => 'rejected',
            default => 'other',
        };
    }
}
