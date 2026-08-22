package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxBodyRunes = 4000
const maxPreviewRunes = 100
const maxUserRunes = 64

var attributeReplacer = strings.NewReplacer(
	"&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;",
)
var previewTagPattern = regexp.MustCompile(`<[^>]*>`)
var closingTransitPattern = regexp.MustCompile(`(?i)</transit`)

type EnvelopeInput struct {
	From           string `json:"from"`
	ID             string `json:"id"`
	TS             string `json:"ts"`
	Kind           string `json:"kind"`
	Room           string `json:"room,omitempty"`
	Seq            int64  `json:"seq,omitempty"`
	Body           string `json:"body"`
	ReplyTo        string `json:"replyTo,omitempty"`
	ReplyTarget    string `json:"replyTarget,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
	Connector      string `json:"connector,omitempty"`
	User           string `json:"user,omitempty"`
	Trigger        string `json:"trigger,omitempty"`
	Redelivery     int    `json:"redelivery,omitempty"`
	Read           bool   `json:"read,omitempty"`
}

type FullEnvelopeInput struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	User           string `json:"user,omitempty"`
	Connector      string `json:"connector"`
	Status         string `json:"status"`
	FirstRead      bool   `json:"firstRead"`
	Settled        bool   `json:"settled"`
	Body           string `json:"body"`
	Instructions   string `json:"instructions,omitempty"`
}

type envelopeAttribute struct{ name, value string }

func clipRunes(value string, limit int) (string, bool) {
	if utf8.RuneCountInString(value) <= limit {
		return value, false
	}
	runes := []rune(value)
	return string(runes[:limit]), true
}

func channelPreview(value string) string {
	flattened := previewTagPattern.ReplaceAllString(value, " ")
	flattened = strings.Join(strings.FieldsFunc(flattened, unicode.IsSpace), " ")
	if flattened == "" {
		return "(no text — attachments or an empty body)"
	}
	preview, _ := clipRunes(flattened, maxPreviewRunes)
	return preview
}

func renderOpeningTag(name string, attributes []envelopeAttribute) string {
	var out strings.Builder
	out.WriteByte('<')
	out.WriteString(name)
	for _, attribute := range attributes {
		out.WriteByte(' ')
		out.WriteString(attribute.name)
		out.WriteString(`="`)
		out.WriteString(attributeReplacer.Replace(attribute.value))
		out.WriteByte('"')
	}
	out.WriteByte('>')
	return out.String()
}

func RenderEnvelope(input EnvelopeInput) string {
	attributes := []envelopeAttribute{
		{"from", input.From}, {"id", input.ID}, {"ts", input.TS}, {"kind", input.Kind},
	}
	if input.Kind == "room" {
		attributes = append(attributes, envelopeAttribute{"room", input.Room}, envelopeAttribute{"seq", strconv.FormatInt(input.Seq, 10)})
	}
	if input.Kind != "channel" && input.ReplyTo != "" {
		attributes = append(attributes, envelopeAttribute{"reply_to", input.ReplyTo})
	}

	body := input.Body
	var hint string
	var status string
	if input.Kind == "channel" {
		if input.Redelivery < 0 {
			input.Redelivery = 0
		}
		user := input.User
		if user == "" {
			user = "unknown"
		}
		user, _ = clipRunes(user, maxUserRunes)
		attributes = append(attributes,
			envelopeAttribute{"conversation_id", input.ConversationID},
			envelopeAttribute{"connector", input.Connector},
			envelopeAttribute{"user", user},
			envelopeAttribute{"redelivery", strconv.Itoa(input.Redelivery)},
		)
		if input.Trigger != "" {
			attributes = append(attributes, envelopeAttribute{"trigger", input.Trigger})
		}
		body = channelPreview(input.Body)
		hint = "[read_message, then settle: chat_reply or mark_handled]"
		if input.Redelivery > 0 {
			if input.Read {
				status = fmt.Sprintf("[redelivery %d, read/unsettled: do not reply twice; chat_reply or mark_handled]", input.Redelivery)
			} else {
				status = fmt.Sprintf("[redelivery %d, unread: already replied? mark_handled; otherwise read_message]", input.Redelivery)
			}
		}
	} else {
		body = closingTransitPattern.ReplaceAllString(input.Body, "&lt;/transit")
		var clipped bool
		body, clipped = clipRunes(body, maxBodyRunes)
		if clipped {
			attributes = append(attributes, envelopeAttribute{"truncated", "1"})
		}
		target := input.From
		if input.ReplyTarget != "" {
			target = input.ReplyTarget
		}
		hint = fmt.Sprintf("[reply: send_message to=\"%s\" reply_to=\"%s\"]", target, input.ID)
	}
	attributes = append(attributes, envelopeAttribute{"schema", "transit/1"})
	lines := []string{renderOpeningTag("transit", attributes), body, hint}
	if status != "" {
		lines = append(lines, status)
	}
	return strings.Join(append(lines, "</transit>"), "\n")
}

func RenderFull(input FullEnvelopeInput) string {
	user := input.User
	if user == "" {
		user = "unknown"
	}
	read := "again"
	if input.FirstRead {
		read = "first"
	}
	attributes := []envelopeAttribute{
		{"id", input.ID}, {"conversation_id", input.ConversationID}, {"user", user},
		{"connector", input.Connector}, {"status", input.Status}, {"read", read}, {"schema", "transit/1"},
	}
	footer := "[settle: chat_reply or mark_handled]"
	if input.Settled {
		footer = "[already settled; history only]"
	}
	lines := []string{renderOpeningTag("transit_full", attributes), input.Body, footer}
	if input.Instructions != "" {
		lines = append(lines, input.Instructions)
	}
	return strings.Join(append(lines, "</transit_full>"), "\n")
}
