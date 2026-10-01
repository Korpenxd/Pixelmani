<?php

declare(strict_types=1);

namespace PixelMani;

/** A fully composed message, ready for a transport. Nothing in it comes raw from the request. */
final class ContactMessage
{
    public function __construct(
        public readonly string $to,
        public readonly string $from,
        public readonly string $fromName,
        public readonly string $replyTo,
        public readonly string $replyToName,
        public readonly string $subject,
        public readonly string $textBody,
        public readonly string $htmlBody,
    ) {}
}

/** Delivers a ContactMessage, or throws MailTransportException. */
interface MailTransport
{
    public function send(ContactMessage $message): void;
}

/**
 * The transport did not accept the message. `category` is a short, safe
 * label for the log (connect, tls, auth, rejected, other); the underlying
 * error text is never shown or logged, as it can contain addresses.
 */
final class MailTransportException extends \RuntimeException
{
    public function __construct(public readonly string $category)
    {
        parent::__construct("Mail transport failed ($category).");
    }
}

/**
 * POST /api/contact: validates a contact-form submission and hands it to the
 * mail transport. Nothing is stored: no database row, no file, and the log
 * holds only outcomes (never the name, address or message).
 *
 * Anti-spam without cookies:
 *   - rate limit per client address (REMOTE_ADDR), see admit()
 *   - a honeypot field the real form never fills: such submissions are
 *     dropped silently and answered like a success
 *   - same-origin check (in the endpoint, before anything else)
 */
final class ContactForm
{
    /** Rate-limit key prefix: a separate bucket from admin login ("admin-login|"). */
    public const RATE_LIMIT_PREFIX = 'contact|';

    /** Hidden field in the real form. Bots fill it; people never see it. */
    public const HONEYPOT_FIELD = 'homepage';

    public const NAME_MAX = 100;
    public const EMAIL_MAX = 254;
    public const MESSAGE_MIN = 2;
    public const MESSAGE_MAX = 5000;

    /** JSON body limit: a 5000-character message stays far below this. */
    public const MAX_BODY_BYTES = 32768;

    public function __construct(
        private readonly ContactConfig $config,
        private readonly RateLimiter $limiter,
        private readonly MailTransport $transport,
        private readonly Logger $logger,
        private readonly string $clientAddress,
    ) {}

    /**
     * Every attempt that reaches this point counts toward the limit, whatever
     * happens next (invalid input, honeypot, delivery failure). That keeps
     * probing and spam bursts cheap to stop. 429 with Retry-After when over.
     */
    public function admit(): void
    {
        $key = self::RATE_LIMIT_PREFIX . $this->clientAddress;
        $retryAfter = $this->limiter->retryAfter($key);

        if ($retryAfter !== null) {
            $this->logger->warning('Contact form rate limit reached', ['client' => $this->clientRef()]);
            throw new HttpException(
                429,
                'too_many_requests',
                'Too many messages. Try again later.',
                ['Retry-After' => (string) $retryAfter]
            );
        }

        $this->limiter->recordFailure($key);
    }

    /**
     * Returns true when the message was handed to the transport, false when it
     * was discarded as spam. The caller answers both the same way.
     *
     * @param array<string, mixed> $body decoded JSON object
     */
    public function submit(array $body): bool
    {
        Input::fields($body, ['name', 'email', 'message'], [self::HONEYPOT_FIELD]);

        if (array_key_exists(self::HONEYPOT_FIELD, $body)) {
            if (!is_string($body[self::HONEYPOT_FIELD])) {
                throw new HttpException(400, 'invalid_request', 'Invalid request.');
            }
            if (trim($body[self::HONEYPOT_FIELD]) !== '') {
                $this->logger->info('Contact form submission discarded', ['client' => $this->clientRef(), 'reason' => 'spam']);
                return false;
            }
        }

        $name = self::name($body['name']);
        $email = self::email($body['email']);
        $message = self::message($body['message']);

        try {
            $this->transport->send($this->compose($name, $email, $message));
        } catch (MailTransportException $e) {
            $this->logger->error('Contact message could not be sent', ['client' => $this->clientRef(), 'transport' => $e->category]);
            throw new HttpException(503, 'mail_unavailable', 'The message could not be sent. Try again later.');
        }

        $this->logger->info('Contact message sent', ['client' => $this->clientRef()]);
        return true;
    }

    public function compose(string $name, string $email, string $message): ContactMessage
    {
        $host = $this->config->siteHost;
        $html = static fn (string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_HTML5 | ENT_SUBSTITUTE, 'UTF-8');

        $text = "Nytt meddelande från kontaktformuläret på $host\n\n"
            . "Namn: $name\n"
            . "E-post: $email\n\n"
            . "Meddelande:\n$message\n\n"
            . "-- \nSvara på det här mejlet för att svara avsändaren.\n";

        $htmlBody = '<!doctype html><html lang="sv"><head><meta charset="utf-8"></head>'
            . '<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">'
            . '<p style="margin:0 0 16px;color:#555">Nytt meddelande från kontaktformuläret på ' . $html($host) . '</p>'
            . '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">'
            . '<tr><td style="padding:2px 16px 2px 0;color:#555">Namn</td><td>' . $html($name) . '</td></tr>'
            . '<tr><td style="padding:2px 16px 2px 0;color:#555">E-post</td><td><a href="mailto:' . $html($email) . '">' . $html($email) . '</a></td></tr>'
            . '</table>'
            . '<p style="margin:0 0 4px;color:#555">Meddelande</p>'
            . '<p style="margin:0">' . nl2br($html($message), false) . '</p>'
            . '<p style="margin:24px 0 0;font-size:13px;color:#888">Svara på det här mejlet för att svara avsändaren.</p>'
            . '</body></html>';

        return new ContactMessage(
            to: $this->config->to,
            from: $this->config->from,
            fromName: $this->config->fromName,
            replyTo: $email,
            replyToName: $name,
            subject: "Nytt meddelande via kontaktformuläret – $host",
            textBody: $text,
            htmlBody: $htmlBody,
        );
    }

    /** 1–100 characters, valid UTF-8, no control or invisible formatting characters (so no CR/LF). */
    public static function name(mixed $value): string
    {
        if (!is_string($value)) {
            throw new HttpException(400, 'invalid_request', 'Invalid request.');
        }
        $name = self::trim($value);
        if ($name === null || $name === '' || mb_strlen($name) > self::NAME_MAX || preg_match('/[\p{Cc}\p{Cf}]/u', $name)) {
            throw new HttpException(400, 'invalid_name', 'Enter your name (at most ' . self::NAME_MAX . ' characters).');
        }
        return $name;
    }

    /** A deliverable address without whitespace or control characters (header-safe). */
    public static function email(mixed $value): string
    {
        if (!is_string($value)) {
            throw new HttpException(400, 'invalid_request', 'Invalid request.');
        }
        $email = self::trim($value);
        $valid = $email === null || strlen($email) > self::EMAIL_MAX ? null : ContactConfig::email($email);
        if ($valid === null) {
            throw new HttpException(400, 'invalid_email', 'Enter a valid email address.');
        }
        return $valid;
    }

    /**
     * 2–5000 characters. Line breaks become \n, tabs are kept, any other
     * control character is refused. Ordinary text (Swedish letters,
     * punctuation, emoji) is kept as written.
     */
    public static function message(mixed $value): string
    {
        if (!is_string($value)) {
            throw new HttpException(400, 'invalid_request', 'Invalid request.');
        }
        $message = self::trim(str_replace(["\r\n", "\r"], "\n", $value));
        if ($message === null
            || preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $message)
            || mb_strlen($message) < self::MESSAGE_MIN
            || mb_strlen($message) > self::MESSAGE_MAX) {
            throw new HttpException(400, 'invalid_message', 'Enter a message of ' . self::MESSAGE_MIN . '–' . self::MESSAGE_MAX . ' characters.');
        }
        return $message;
    }

    /** Trims ASCII and Unicode whitespace; null for invalid UTF-8. */
    private static function trim(string $value): ?string
    {
        if (!mb_check_encoding($value, 'UTF-8')) {
            return null;
        }
        return (string) preg_replace('/^[\s\p{Z}]+|[\s\p{Z}]+$/u', '', $value);
    }

    private function clientRef(): string
    {
        return substr(hash('sha256', 'pixelmani-client|' . $this->clientAddress), 0, 12);
    }
}
